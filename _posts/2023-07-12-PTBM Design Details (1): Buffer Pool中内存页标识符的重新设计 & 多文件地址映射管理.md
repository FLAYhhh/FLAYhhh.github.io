---
layout: post
title: 
date: 2023-07-12 13:10:00+0800
description:
categories: PG
tags: PT-BM
giscus_comments: true
related_posts: false
toc:
  beginning: true
---

# PTBM Design Details (1): Buffer Pool中内存页标识符的重新设计 & 多文件地址映射管理

## 1. BufferDesc & ptedit_pte_t

BufferDesc是buffer manager中的重要类型. 对应buffer pool中的每个buffer frame, 都有与之对应的BufferDesc来描述该Buffer frame的状态. 换句话说, 每个内存页都需要一个BufferDesc描述其状态. 在Ptbm的设计中, pte可以替代bufferdesc的功能.

首先给出这两个类型的定义：

```c
// ptedit_header.h
typedef struct {
    size_t present : 1; // 
    size_t writeable : 1;
    size_t user_access : 1;
    size_t write_through : 1;
    size_t cache_disabled : 1;
    size_t accessed : 1;
    size_t dirty : 1;
    size_t size : 1;
    size_t global : 1;
    size_t ignored_2 : 3;
    size_t pfn : 28;
    size_t reserved_1 : 12;
    size_t ignored_1 : 11;
    size_t execution_disabled : 1;
} ptedit_pte_t;
// pte中预留了 12 + 11 + 3 = 26 bit

//==========================================================================
// buf_internals.h
/*
 * Buffer state is a single 32-bit variable where following data is combined.
 *
 * - 18 bits refcount
 * - 4 bits usage count
 * - 10 bits of flags
 *
 * Combining these values allows to perform some operations without locking
 * the buffer header, by modifying them together with a CAS loop.
 *
 * The definition of buffer state components is below.
 */
#define BUF_REFCOUNT_ONE 1
#define BUF_REFCOUNT_MASK ((1U << 18) - 1)
#define BUF_USAGECOUNT_MASK 0x003C0000U
#define BUF_USAGECOUNT_ONE (1U << 18)
#define BUF_USAGECOUNT_SHIFT 18
#define BUF_FLAG_MASK 0xFFC00000U

/* Get refcount and usagecount from buffer state */
#define BUF_STATE_GET_REFCOUNT(state) ((state) & BUF_REFCOUNT_MASK)
#define BUF_STATE_GET_USAGECOUNT(state) (((state) & BUF_USAGECOUNT_MASK) >> BUF_USAGECOUNT_SHIFT)
/*
 * Flags for buffer descriptors
 *
 * Note: BM_TAG_VALID essentially means that there is a buffer hashtable
 * entry associated with the buffer's tag.
 */
#define BM_LOCKED				(1U << 22)	/* buffer header is locked */
#define BM_DIRTY				(1U << 23)	/* data needs writing */
#define BM_VALID				(1U << 24)	/* data is valid */
#define BM_TAG_VALID			(1U << 25)	/* tag is assigned */
#define BM_IO_IN_PROGRESS		(1U << 26)	/* read or write in progress */
#define BM_IO_ERROR				(1U << 27)	/* previous I/O failed */
#define BM_JUST_DIRTIED			(1U << 28)	/* dirtied since write started */
#define BM_PIN_COUNT_WAITER		(1U << 29)	/* have waiter for sole pin */
#define BM_CHECKPOINT_NEEDED	(1U << 30)	/* must write for checkpoint */
#define BM_PERMANENT			(1U << 31)	/* permanent buffer (not unlogged,
											 * or init fork) */
typedef struct BufferDesc
{
	BufferTag	tag;			/* ID of page contained in buffer */
	int			buf_id;			/* buffer's index number (from 0) */

	/* state of the tag, containing flags, refcount and usagecount */
	pg_atomic_uint32 state;

	int			wait_backend_pgprocno;	/* backend of pin-count waiter */
	int			freeNext;		/* link in freelist chain */
	LWLock		content_lock;	/* to lock access to buffer contents */
} BufferDesc;
```

BufferDesc.state中标记位（10个）和ptedit_pte_t中标记位的对比：


| BufferDesc.state | ptedit_pte_t | 说明 |
| :----------- | :------------: | ------------: |
| BM_LOCKED      |        | (存疑）猜测用于锁定整个BufferDesc。需要具体考察该bit的作用，例如：锁定BufferDesc的期间是否有除了修改成员之外的需求。如果只是为了原子的修改BufferDesc，则ptedit_pte_t不需要类似的标记，因为ptedit_pte_t为64bit大小，我们可以通过原子操作修改其中的bit。      |
| BM_DIRTY       | dirty       | 这两个标记可以合并       |
| BM_VALID      |  present      | （存疑）也许可以和present合并       |
| BM_TAG_VALID | | BufferDesc中需要存储tag，ptbm的设计不需要tag。 |
| BM_IO_IN_PROGRESS | 新增 | ptbm需要新增类似的bit。1. 预读时分配物理内存， 并将pfn写入pte。但是present为false。2.进行异步IO或预读。在pte中设置IO_IN_PROGRESS标记位。 3.预读完成后再次将pte修改为有效状态 4.正式的读流程中需要check IO_IN_PROGESS标记位。 |
| BM_IO_ERROR				 | 新增 | ptbm需要新增类似的bit。 如果IO错误，page中可能包含错误的内容。 |
| BM_JUST_DIRTIED			 | 新增 | ptbm需要新增类似的bit（需要详细考察） |
| BM_PIN_COUNT_WAITER		 | 新增 | （存疑）BufferDesc中记录了等待者的id，但是pte中没有空间容纳等待者的id。解决方法：1. 不记录等待者。2. 使用哈希结构将等待者放在其他地方。 |
| BM_CHECKPOINT_NEEDED	 | 新增 | （需要详细考察）需要详细地了解checkpoint逻辑。 |
| BM_PERMANENT			 | 新增 | ptbm需要新增类似的bit。 |
|  |  |  |


> * Buffer state is a single 32-bit variable where following data is combined.
 *
 * - 18 bits refcount
 * - 4 bits usage count
 * - 10 bits of flags
> 

BufferDesc.state一共32bit，而pte中只预留了26bit， 所以需要压缩一下state。

BufferDesc.State分为三个部分: refcount(18 bit), usage count(4 bit), flags(10 bit). 在上面的表格中，我们分析了如果使用ptbm的设计，flag可以缩减到 6bit。如果将refcount缩减到16bit，那么BufferDesc.state可以用26bit表示。

```c
/*
 * The maximum allowed value of usage_count represents a tradeoff between
 * accuracy and speed of the clock-sweep buffer management algorithm.  A
 * large value (comparable to NBuffers) would approximate LRU semantics.
 * But it can take as many as BM_MAX_USAGE_COUNT+1 complete cycles of
 * clock sweeps to find a free buffer, so in practice we don't want the
 * value to be very large.
 */ 
#define BM_MAX_USAGE_COUNT	5
```

BufferDesc.state中的usage count似乎和替换算法有关。如果采用了ptbm，如何设计替换算法？

原本的替换算法为clock sweeping，需要扫描buffer pool中所有的buffer。usage count在某个进程访问某个page时递增，在每次扫描到该buffer时递减。当usage count为0时，该buffer被替换。clock sweeping 遇到被pin住的buffer会跳过。

重新设计ptbm需要扫描所有的物理page，并在page struct里记录usage count。

这样 pte中也不需要存储usage count。

经过以上的分析，pte中只需要记录refcount（18 bit）和flags （6 bit）。

## 2. 进一步确认linux源码中pte的定义

```c
// /arch/x86/include/asm/pgtable_types.h

#define _PAGE_BIT_PRESENT	0	/* is present */
#define _PAGE_BIT_RW		1	/* writeable */
#define _PAGE_BIT_USER		2	/* userspace addressable */
#define _PAGE_BIT_PWT		3	/* page write through */
#define _PAGE_BIT_PCD		4	/* page cache disabled */
#define _PAGE_BIT_ACCESSED	5	/* was accessed (raised by CPU) */
#define _PAGE_BIT_DIRTY		6	/* was written to (raised by CPU) */
#define _PAGE_BIT_PSE		7	/* 4 MB (or 2MB) page */
#define _PAGE_BIT_PAT		7	/* on 4KB pages */
#define _PAGE_BIT_GLOBAL	8	/* Global TLB entry PPro+ */
#define _PAGE_BIT_SOFTW1	9	/* available for programmer */
#define _PAGE_BIT_SOFTW2	10	/* " */
#define _PAGE_BIT_SOFTW3	11	/* " */
#define _PAGE_BIT_PAT_LARGE	12	/* On 2MB or 1GB pages */
#define _PAGE_BIT_SOFTW4	58	/* available for programmer */
#define _PAGE_BIT_PKEY_BIT0	59	/* Protection Keys, bit 1/4 */
#define _PAGE_BIT_PKEY_BIT1	60	/* Protection Keys, bit 2/4 */
#define _PAGE_BIT_PKEY_BIT2	61	/* Protection Keys, bit 3/4 */
#define _PAGE_BIT_PKEY_BIT3	62	/* Protection Keys, bit 4/4 */
#define _PAGE_BIT_NX		63	/* No execute: only valid after cpuid check */

#define _PAGE_BIT_SPECIAL	_PAGE_BIT_SOFTW1
#define _PAGE_BIT_CPA_TEST	_PAGE_BIT_SOFTW1
#define _PAGE_BIT_UFFD_WP	_PAGE_BIT_SOFTW2 /* userfaultfd wrprotected */
#define _PAGE_BIT_SOFT_DIRTY	_PAGE_BIT_SOFTW3 /* software dirty tracking */
#define _PAGE_BIT_DEVMAP	_PAGE_BIT_SOFTW4
```

关于pte中哪些bit可用，有很多不同的说法：

- https://stackoverflow.com/questions/50102068/how-to-use-page-bit-softw1 这篇文章说4个保留位不一定能全部使用，反而52-57可以使用。
- PTEditor的作者说只能使用4个保留位
- https://01.org/blogs/dave/2020/linux-consumption-x86-page-table-bits 这篇文章介绍了预留位的一些作用。

一劳永逸的解决方法：

除了BM_VALID/present， 其他flag都可以放在page header中。

## 3. Build and manage Mmap

首先，我们类比一下传统buffer manager处理一次“读磁盘页”的流程：

1. 从storage manager中获取磁盘页地址;
2. 在buffer pool中获取一个buffer frame;
3. 在哈希表中建立page tag 到 buffer frame的映射;

在这个过程中，所有文件的磁盘页都统一分散在哈希表中。一个文件和多个文件无需区别对待。

而在ptbm中，由于mmap的映射是顺序的，尽管我们没有直接使用基于文件的mmap，但是在地址空间的对应关系上仍然和基于文件的mmap相同。我们将一段连续的虚拟内存空间映射到了一个文件中的一段连续的IO地址空间。由于我们计划使用共享内存，所以只有一段虚拟地质空间，但是每个releation都会对应一个或多个文件，所以出现了一个虚拟地址空间对应多个文件IO地址空间的情况。

**如何处理这种一对多的关系？**

我们打算采用分段的方式处理一对多的关系。每个文件IO空间都对应虚拟地址空间中的一段。一段的大小默认为2GB（可以调整默认值）。当文件大小超出当前虚拟地址空间中所分配的段大小时，重新在虚拟地址空间中分配2倍于原来段大小的空间。注意，这里只是重新分配虚拟地址空间，所以我们只需要操作页表，改变虚拟地址到物理地址的映射关系，而无需进行拷贝操作。

为此我们定义一个bookkeeper类型，记录每个文件对应的起始映射地址和段大小。另外，我们希望每次读取磁盘页时能够直接获取该磁盘页所在文件的映射地址，而无需通过文件名查找哈希表找到映射地址，所以我们还需要将起始映射地址从bookkeeper同步到每个文件在pg中的元数据表示。

```jsx
struct MappingSegmentShared {
  char file_name[N]; 
  void *mapping_start;
  size_t len; // count in byte, but align to 1GB.
  MappingSegmentShared *prev;
  MappingSegmentShared *next;
};

// bookkeeper 类型
struct PtbmShared {
  // need util like vector
  LWLock lock;
  Hash_table segments; // sorted by mapping start.
  build_new_mapping(); // when reading new file
  unmapping();
  extent_segment(); // 扩容
};
```

需要注意的是, ptbmShared以及成员segments都需要存放在共享内存中. 关于共享内存中的数据可结构, 可以参考“Postgresql Shared Hash Table”.

下面给出ptbm book keeper草图:

<img src="/assets/img/ptbm_segments.jpeg" width="400" height="400">


下一步是根据草图在pg中实现ptbm的book keep. 另外需要将book keeper中的映射关系同步至file metadata cache中.
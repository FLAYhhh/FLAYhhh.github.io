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
  sidebar: left
---

## 1. 背景

在Design Details(1)中我们提到, 可以通过一个基于哈希表的book keeper管理所有文件到虚拟地址空间的映射: FileNaming → Mapping range. 但是我们不希望每次对某个文件的page进行read, write时都去查询这个book keeper, 所以我们还需要将映射关系缓存到每个文件的metadata cache中.

## 2. 在PG中找到表示File metadata cache的数据结构

目前File metadata cache只是我们对Storage manager管理文件方式的一个假设, 所以需要在代码中找到真正表示它的数据结构.

### 2.1 ReadBuffer

我的思路是从ReadBuffer开始找. 因为ReadBuffer的语义是给次一个磁盘页的位置, 将其内容读取到buffer frame中. PG在给定磁盘页位置(其中必然包含了文件id)进行IO时, 可能会使用我们上面假设的File metadata cache结构. 例如, 其中可能会包含文件描述符. 如果有这个变量, 我们期望它在每个backend中是全局唯一的, 这样我们一旦将映射关系缓存到File metadata cache中, 如果映射关系不发生变化, 则其生命周期就会和backend的生命周期一样长.

```c
/*
 * ReadBuffer -- a shorthand for ReadBufferExtended, for reading from main
 *		fork with RBM_NORMAL mode and default strategy.
 */
Buffer
ReadBuffer(Relation reln, BlockNumber blockNum)
{
	return ReadBufferExtended(reln, MAIN_FORKNUM, blockNum, RBM_NORMAL, NULL);
}

/*
 * ReadBufferExtended -- returns a buffer containing the requested
 *		block of the requested relation.  If the blknum
 *		requested is P_NEW, extend the relation file and
 *		allocate a new block.  (Caller is responsible for
 *		ensuring that only one backend tries to extend a
 *		relation at the same time!)
 *
 * Returns: the buffer number for the buffer containing
 *		the block read.  The returned buffer has been pinned.
 *		Does not return on error --- elog's instead.
 *
 * Assume when this function is called, that reln has been opened already.
 *
 * In RBM_NORMAL mode, the page is read from disk, and the page header is
 * validated.  An error is thrown if the page header is not valid.  (But
 * note that an all-zero page is considered "valid"; see
 * PageIsVerifiedExtended().)
 *
 * RBM_ZERO_ON_ERROR is like the normal mode, but if the page header is not
 * valid, the page is zeroed instead of throwing an error. This is intended
 * for non-critical data, where the caller is prepared to repair errors.
 *
 * In RBM_ZERO_AND_LOCK mode, if the page isn't in buffer cache already, it's
 * filled with zeros instead of reading it from disk.  Useful when the caller
 * is going to fill the page from scratch, since this saves I/O and avoids
 * unnecessary failure if the page-on-disk has corrupt page headers.
 * The page is returned locked to ensure that the caller has a chance to
 * initialize the page before it's made visible to others.
 * Caution: do not use this mode to read a page that is beyond the relation's
 * current physical EOF; that is likely to cause problems in md.c when
 * the page is modified and written out. P_NEW is OK, though.
 *
 * RBM_ZERO_AND_CLEANUP_LOCK is the same as RBM_ZERO_AND_LOCK, but acquires
 * a cleanup-strength lock on the page.
 *
 * RBM_NORMAL_NO_LOG mode is treated the same as RBM_NORMAL here.
 *
 * If strategy is not NULL, a nondefault buffer access strategy is used.
 * See buffer/README for details.
 */
Buffer
ReadBufferExtended(Relation reln, ForkNumber forkNum, BlockNumber blockNum,
				   ReadBufferMode mode, BufferAccessStrategy strategy)
{
	bool		hit;
	Buffer		buf;

	/*
	 * Reject attempts to read non-local temporary relations; we would be
	 * likely to get wrong data since we have no visibility into the owning
	 * session's local buffers.
	 */
	if (RELATION_IS_OTHER_TEMP(reln))
		ereport(ERROR,
				(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
				 errmsg("cannot access temporary tables of other sessions")));

	/*
	 * Read the buffer, and update pgstat counters to reflect a cache hit or
	 * miss.
	 */
	pgstat_count_buffer_read(reln);
	buf = ReadBuffer_common(RelationGetSmgr(reln), reln->rd_rel->relpersistence,
							forkNum, blockNum, mode, strategy, &hit);
	if (hit)
		pgstat_count_buffer_hit(reln);
	return buf;
}

/*
 * ReadBufferWithoutRelcache -- like ReadBufferExtended, but doesn't require
 *		a relcache entry for the relation.
 *
 * Pass permanent = true for a RELPERSISTENCE_PERMANENT relation, and
 * permanent = false for a RELPERSISTENCE_UNLOGGED relation. This function
 * cannot be used for temporary relations (and making that work might be
 * difficult, unless we only want to read temporary relations for our own
 * BackendId).
 */
Buffer
ReadBufferWithoutRelcache(RelFileLocator rlocator, ForkNumber forkNum,
						  BlockNumber blockNum, ReadBufferMode mode,
						  BufferAccessStrategy strategy, bool permanent)
{
	bool		hit;

	SMgrRelation smgr = smgropen(rlocator, InvalidBackendId);

	return ReadBuffer_common(smgr, permanent ? RELPERSISTENCE_PERMANENT :
							 RELPERSISTENCE_UNLOGGED, forkNum, blockNum,
							 mode, strategy, &hit);
}
```

> 每个Relation有多个Fork, 每个Fork对应一个或多个文件. 可以参考: [Postgres 15 internals #2: Files and forks](https://blog.devgenius.io/postgres-15-internals-2-files-and-forks-e2cc6da4695d)
> 

我们感兴趣的是pg如何使用relation和fork找到对应的文件:

```c
buf = ReadBuffer_common(RelationGetSmgr(reln), reln->rd_rel->relpersistence,
							forkNum, blockNum, mode, strategy, &hit);
```

可以看到到这里为止forkNum没有变化, 但是reln转换成了RelationGetSmgr(reln)传递给ReadBuffer_common.

我们首先看一看RelationGetSmgr, 然后再看一看ReadBuffer_common.

```c
/*
 * RelationGetSmgr
 *		Returns smgr file handle for a relation, opening it if needed.
 *
 * Very little code is authorized to touch rel->rd_smgr directly.  Instead
 * use this function to fetch its value.
 *
 * Note: since a relcache flush can cause the file handle to be closed again,
 * it's unwise to hold onto the pointer returned by this function for any
 * long period.  Recommended practice is to just re-execute RelationGetSmgr
 * each time you need to access the SMgrRelation.  It's quite cheap in
 * comparison to whatever an smgr function is going to do.
 */
static inline SMgrRelation
RelationGetSmgr(Relation rel)
{
	if (unlikely(rel->rd_smgr == NULL))
		smgrsetowner(&(rel->rd_smgr), smgropen(rel->rd_locator, rel->rd_backend));
	return rel->rd_smgr;
}
```

> relcache flush会导致file handle即rel→rd_smgr关闭, 如果仍然有人使用rel→rd_smgr怎么办?
> 

稍微看一看smgropen和smgrsetowner.

```c
为了阅读sgmropen, 熟悉需要熟悉几个类型. 

typedef struct RelationData *Relation;

/*
 * Here are the contents of a relation cache entry.
 */

typedef struct RelationData
{
	RelFileLocator rd_locator;	/* relation physical identifier */
	SMgrRelation rd_smgr;		/* cached file handle, or NULL */
	int			rd_refcnt;		/* reference count */
	BackendId	rd_backend;		/* owning backend id, if temporary relation */
	bool		rd_islocaltemp; /* rel is a temp rel of this session */
	bool		rd_isnailed;	/* rel is nailed in cache */
	bool		rd_isvalid;		/* relcache entry is valid */
	bool		rd_indexvalid;	/* is rd_indexlist valid? (also rd_pkindex and
								 * rd_replidindex) */
	bool		rd_statvalid;	/* is rd_statlist valid? */

  ...
} RelationData;

/*
 * Augmenting a relfilelocator with the backend ID provides all the information
 * we need to locate the physical storage.  The backend ID is InvalidBackendId
 * for regular relations (those accessible to more than one backend), or the
 * owning backend's ID for backend-local relations.  Backend-local relations
 * are always transient and removed in case of a database crash; they are
 * never WAL-logged or fsync'd.
 */
typedef struct RelFileLocatorBackend
{
	RelFileLocator locator;
	BackendId	backend;
} RelFileLocatorBackend;

typedef SMgrRelationData *SMgrRelation;

/*
 * smgr.c maintains a table of SMgrRelation objects, which are essentially
 * cached file handles.  An SMgrRelation is created (if not already present)
 * by smgropen(), and destroyed by smgrclose().  Note that neither of these
 * operations imply I/O, they just create or destroy a hashtable entry.
 * (But smgrclose() may release associated resources, such as OS-level file
 * descriptors.)
 *
 * An SMgrRelation may have an "owner", which is just a pointer to it from
 * somewhere else; smgr.c will clear this pointer if the SMgrRelation is
 * closed.  We use this to avoid dangling pointers from relcache to smgr
 * without having to make the smgr explicitly aware of relcache.  There
 * can't be more than one "owner" pointer per SMgrRelation, but that's
 * all we need.
 *
 * SMgrRelations that do not have an "owner" are considered to be transient,
 * and are deleted at end of transaction.
 */
typedef struct SMgrRelationData
{
	/* rlocator is the hashtable lookup key, so it must be first! */
	RelFileLocatorBackend smgr_rlocator;	/* relation physical identifier */

	/* pointer to owning pointer, or NULL if none */
	struct SMgrRelationData **smgr_owner;

	/*
	 * The following fields are reset to InvalidBlockNumber upon a cache flush
	 * event, and hold the last known size for each fork.  This information is
	 * currently only reliable during recovery, since there is no cache
	 * invalidation for fork extension.
	 */
	BlockNumber smgr_targblock; /* current insertion target block */
	BlockNumber smgr_cached_nblocks[MAX_FORKNUM + 1];	/* last known size */

	/* additional public fields may someday exist here */

	/*
	 * Fields below here are intended to be private to smgr.c and its
	 * submodules.  Do not touch them from elsewhere.
	 */
	int			smgr_which;		/* storage manager selector */

	/*
	 * for md.c; per-fork arrays of the number of open segments
	 * (md_num_open_segs) and the segments themselves (md_seg_fds).
	 */
	int			md_num_open_segs[MAX_FORKNUM + 1];
	struct _MdfdVec *md_seg_fds[MAX_FORKNUM + 1];

	/* if unowned, list link in list of all unowned SMgrRelations */
	dlist_node	node;
} SMgrRelationData;

/*
 * smgropen() -- Return an SMgrRelation object, creating it if need be.
 *
 * This does not attempt to actually open the underlying file.
 */
SMgrRelation
smgropen(RelFileLocator rlocator, BackendId backend)
{
	RelFileLocatorBackend brlocator;
	SMgrRelation reln;
	bool		found;

	if (SMgrRelationHash == NULL)
	{
		/* First time through: initialize the hash table */
		HASHCTL		ctl;

		ctl.keysize = sizeof(RelFileLocatorBackend);
		ctl.entrysize = sizeof(SMgrRelationData);
		SMgrRelationHash = hash_create("smgr relation table", 400,
									   &ctl, HASH_ELEM | HASH_BLOBS);
		dlist_init(&unowned_relns);
	}

	/* Look up or create an entry */
	brlocator.locator = rlocator;
	brlocator.backend = backend;
	reln = (SMgrRelation) hash_search(SMgrRelationHash,
									  &brlocator,
									  HASH_ENTER, &found);

	/* Initialize it if not present before */
	if (!found)
	{
		/* hash_search already filled in the lookup key */
		reln->smgr_owner = NULL;
		reln->smgr_targblock = InvalidBlockNumber;
		for (int i = 0; i <= MAX_FORKNUM; ++i)
			reln->smgr_cached_nblocks[i] = InvalidBlockNumber;
		reln->smgr_which = 0;	/* we only have md.c at present */

		/* implementation-specific initialization */
		smgrsw[reln->smgr_which].smgr_open(reln);

		/* it has no owner yet */
		dlist_push_tail(&unowned_relns, &reln->node);
	}

	return reln;
}
```

关键数据结构: **SMgrRelationHash**

这个哈希表的映射关系为: RelFileLocatorBackend (关系)→ SMgrRelationData(文件句柄).

另外通过unowned_relns将所有没有拥有者的SMgrRelationData链接起来.

所有打开的relation都会被缓存到哈希表中, 在smgr_open中, 如果没有在哈希表中查询到relation, 则新创建一个entry, 并将其放入unowned_relns中. 另外还需要调用smgrsw[reln→smgr_which].smgr_open(). 选择具体设备的操作进行open.

```c
static const f_smgr smgrsw[] = {
	/* magnetic disk */
	{
		.smgr_init = mdinit,
		.smgr_shutdown = NULL,
		.smgr_open = mdopen,
		.smgr_close = mdclose,
		.smgr_create = mdcreate,
		.smgr_exists = mdexists,
		.smgr_unlink = mdunlink,
		.smgr_extend = mdextend,
		.smgr_zeroextend = mdzeroextend,
		.smgr_prefetch = mdprefetch,
		.smgr_read = mdread,
		.smgr_write = mdwrite,
		.smgr_writeback = mdwriteback,
		.smgr_nblocks = mdnblocks,
		.smgr_truncate = mdtruncate,
		.smgr_immedsync = mdimmedsync,
	}
};
```

通常reln→smgr_which的值为0. 默认为磁盘.

继续阅读mdopen的代码:

```c
/*
 * mdopen() -- Initialize newly-opened relation.
 */
void
mdopen(SMgrRelation reln)
{
	/* mark it not open */
	for (int forknum = 0; forknum <= MAX_FORKNUM; forknum++)
		reln->md_num_open_segs[forknum] = 0;
}
```

现在看reln→md_num_open_segs[forknum]还是有点抽象, 所以还需要再探SMgrRelationData中的两个成员:

```c
struct SMgrRelationData {
...
  /*
	 * for md.c; per-fork arrays of the number of open segments
	 * (md_num_open_segs) and the segments themselves (md_seg_fds).
	 */
	int			md_num_open_segs[MAX_FORKNUM + 1]; // 每个fork打开的segment(文件)数量
	struct _MdfdVec *md_seg_fds[MAX_FORKNUM + 1]; // 每个fork都对应一个_MdfdVec数组,
                                           // 数组中每个元素为segment
																					 //(包含segment编号和该segment的fd)
...
};

以及 struct _MdfdVec的定义:

/*
 * The magnetic disk storage manager keeps track of open file
 * descriptors in its own descriptor pool.  This is done to make it
 * easier to support relations that are larger than the operating
 * system's file size limit (often 2GBytes).  In order to do that,
 * we break relations up into "segment" files that are each shorter than
 * the OS file size limit.  The segment size is set by the RELSEG_SIZE
 * configuration constant in pg_config.h.
 *
 * On disk, a relation must consist of consecutively numbered segment
 * files in the pattern
 *	-- Zero or more full segments of exactly RELSEG_SIZE blocks each
 *	-- Exactly one partial segment of size 0 <= size < RELSEG_SIZE blocks
 *	-- Optionally, any number of inactive segments of size 0 blocks.
 * The full and partial segments are collectively the "active" segments.
 * Inactive segments are those that once contained data but are currently
 * not needed because of an mdtruncate() operation.  The reason for leaving
 * them present at size zero, rather than unlinking them, is that other
 * backends and/or the checkpointer might be holding open file references to
 * such segments.  If the relation expands again after mdtruncate(), such
 * that a deactivated segment becomes active again, it is important that
 * such file references still be valid --- else data might get written
 * out to an unlinked old copy of a segment file that will eventually
 * disappear.
 *
 * File descriptors are stored in the per-fork md_seg_fds arrays inside
 * SMgrRelation. The length of these arrays is stored in md_num_open_segs.
 * Note that a fork's md_num_open_segs having a specific value does not
 * necessarily mean the relation doesn't have additional segments; we may
 * just not have opened the next segment yet.  (We could not have "all
 * segments are in the array" as an invariant anyway, since another backend
 * could extend the relation while we aren't looking.)  We do not have
 * entries for inactive segments, however; as soon as we find a partial
 * segment, we assume that any subsequent segments are inactive.
 *
 * The entire MdfdVec array is palloc'd in the MdCxt memory context.
 */

typedef struct _MdfdVec
{
	File		mdfd_vfd;		/* fd number in fd.c's pool */
	BlockNumber mdfd_segno;		/* segment number, from 0 */
} MdfdVec;
```

现在清楚mdopen将relation的所有fork中打开的segment数量置为0.

回到smgropen()这个函数, 它只是在哈希表中创建了一个SMgrRelationData entry, 并将其放入了一个无拥有者的链表中. 另外将该relation每个fork中的open segments数量置为0.

接下来看ReadBuffer_common:

```c
/*
 * ReadBuffer_common -- common logic for all ReadBuffer variants
 *
 * *hit is set to true if the request was satisfied from shared buffer cache.
 */
static Buffer
ReadBuffer_common(SMgrRelation smgr, char relpersistence, ForkNumber forkNum,
				  BlockNumber blockNum, ReadBufferMode mode,
				  BufferAccessStrategy strategy, bool *hit)
{
	...
	/*
	 * Read in the page, unless the caller intends to overwrite it and just
	 * wants us to allocate a buffer.
	 */
	if (mode == RBM_ZERO_AND_LOCK || mode == RBM_ZERO_AND_CLEANUP_LOCK)
		MemSet((char *) bufBlock, 0, BLCKSZ);
	else
	{
		...
		***smgrread(smgr, forkNum, blockNum, bufBlock);***
		...
	}

  ...
	{
		/* Set BM_VALID, terminate IO, and wake up any waiters */
		TerminateBufferIO(bufHdr, false, BM_VALID);
	}
  ...
	return BufferDescriptorGetBuffer(bufHdr);
}
```

具体代码参见附录A.1, 本文的重点是找到合适的file handle cache, 目前看来SMgrRelationData担任了这个角色, smgropen中只是初始化了smgr的成员, 现在期望通过详细观察sgmrread能够理清smgr的在io流程中的具体作用.

```c
.smgr_read = mdread

/*
 * mdread() -- Read the specified block from a relation.
 */
void
mdread(SMgrRelation reln, ForkNumber forknum, BlockNumber blocknum,
	   void *buffer)
{
	off_t		seekpos;
	int			nbytes;
	MdfdVec    *v;

	/* If this build supports direct I/O, the buffer must be I/O aligned. */
	if (PG_O_DIRECT != 0 && PG_IO_ALIGN_SIZE <= BLCKSZ)
		Assert((uintptr_t) buffer == TYPEALIGN(PG_IO_ALIGN_SIZE, buffer));

	TRACE_POSTGRESQL_SMGR_MD_READ_START(forknum, blocknum,
										reln->smgr_rlocator.locator.spcOid,
										reln->smgr_rlocator.locator.dbOid,
										reln->smgr_rlocator.locator.relNumber,
										reln->smgr_rlocator.backend);

	v = _mdfd_getseg(reln, forknum, blocknum, false,
					 EXTENSION_FAIL | EXTENSION_CREATE_RECOVERY);

	seekpos = (off_t) BLCKSZ * (blocknum % ((BlockNumber) RELSEG_SIZE));

	Assert(seekpos < (off_t) BLCKSZ * RELSEG_SIZE);

	nbytes = FileRead(v->mdfd_vfd, buffer, BLCKSZ, seekpos, WAIT_EVENT_DATA_FILE_READ);

	TRACE_POSTGRESQL_SMGR_MD_READ_DONE(forknum, blocknum,
									   reln->smgr_rlocator.locator.spcOid,
									   reln->smgr_rlocator.locator.dbOid,
									   reln->smgr_rlocator.locator.relNumber,
									   reln->smgr_rlocator.backend,
									   nbytes,
									   BLCKSZ);

	if (nbytes != BLCKSZ)
	{
		if (nbytes < 0)
			ereport(ERROR,
					(errcode_for_file_access(),
					 errmsg("could not read block %u in file \"%s\": %m",
							blocknum, FilePathName(v->mdfd_vfd))));

		/*
		 * Short read: we are at or past EOF, or we read a partial block at
		 * EOF.  Normally this is an error; upper levels should never try to
		 * read a nonexistent block.  However, if zero_damaged_pages is ON or
		 * we are InRecovery, we should instead return zeroes without
		 * complaining.  This allows, for example, the case of trying to
		 * update a block that was later truncated away.
		 */
		if (zero_damaged_pages || InRecovery)
			MemSet(buffer, 0, BLCKSZ);
		else
			ereport(ERROR,
					(errcode(ERRCODE_DATA_CORRUPTED),
					 errmsg("could not read block %u in file \"%s\": read only %d of %d bytes",
							blocknum, FilePathName(v->mdfd_vfd),
							nbytes, BLCKSZ)));
	}
}
```

md_read调用_mdfd_getseg初始化文件描述符.

看到这里, 基本达到了寻找File metadata cache的目的. pg中File meta data cache就是SMgrRelationData. 

熟悉SMgrRelationData后, 需要纠正一些Book keeper中的设计. 

- 不能以文件为单位管理映射, 因为一个Fork可能有多个segment组成, 但是这些segment虽然是不同的文件, 但是IO空间相同. 所以book keeper中应该以relation + fork作为key, 映射到特定relation的特定fork对应的虚拟地址空间.

## 3. PTBM对SMgrRelationData的修改

需要新增成员数组: ***md_fork_mapping_start***

- NULL值为无效值, 说明还没有建立映射.
- 非NULL值为该fork在shared memory中的映射地址.

```c
struct SMgrRelationData {
...
  /*
	 * for md.c; per-fork arrays of the number of open segments
	 * (md_num_open_segs) and the segments themselves (md_seg_fds).
	 */
	int			md_num_open_segs[MAX_FORKNUM + 1]; // 每个fork打开的segment(文件)数量
	struct _MdfdVec *md_seg_fds[MAX_FORKNUM + 1]; // 每个fork都对应一个_MdfdVec数组,
                                           // 数组中每个元素为segment
																					 //(包含segment编号和该segment的fd)
  ***void *md_fork_mapping_start[MAX_FORKNUM + 1];***
...
};
```

## 4. SMgrRelationData的所有权 & 并发安全

> 首先抛出一个重要问题: PG如何保证SMgrRelationData时的并发安全?
> 

函数RelationGetSmgr()中调用了smgrsetowner设置smgr的所有权.

```c
/*
 * smgrsetowner() -- Establish a long-lived reference to an SMgrRelation object
 *
 * There can be only one owner at a time; this is sufficient since currently
 * the only such owners exist in the relcache.
 */
void
smgrsetowner(SMgrRelation *owner, SMgrRelation reln)
{
	/* We don't support "disowning" an SMgrRelation here, use smgrclearowner */
	Assert(owner != NULL);

	/*
	 * First, unhook any old owner.  (Normally there shouldn't be any, but it
	 * seems possible that this can happen during swap_relation_files()
	 * depending on the order of processing.  It's ok to close the old
	 * relcache entry early in that case.)
	 *
	 * If there isn't an old owner, then the reln should be in the unowned
	 * list, and we need to remove it.
	 */
	if (reln->smgr_owner)
		*(reln->smgr_owner) = NULL;
	else
		dlist_delete(&reln->node);

	/* Now establish the ownership relationship. */
	reln->smgr_owner = owner;
	*owner = reln;
}
```

猜测(与smgrsetowner无关): smgr是process local的变量, 多进程读写同一个文件的并发安全由buffer manager通过buffer descriptor控制. 因为每个backend在读写磁盘页之前都会检查并设置buffer descriptor中的读写锁. 所以下层storage manager进行文件IO时可能是并发安全的.

## A. 附录

### A.1 ReadBuffer_common解析

TODO

```c
/*
 * ReadBuffer_common -- common logic for all ReadBuffer variants
 *
 * *hit is set to true if the request was satisfied from shared buffer cache.
 */
static Buffer
ReadBuffer_common(SMgrRelation smgr, char relpersistence, ForkNumber forkNum,
				  BlockNumber blockNum, ReadBufferMode mode,
				  BufferAccessStrategy strategy, bool *hit)
{
	BufferDesc *bufHdr;
	Block		bufBlock;
	bool		found;
	IOContext	io_context;
	IOObject	io_object;
	bool		isLocalBuf = SmgrIsTemp(smgr);

	*hit = false;

	/*
	 * Backward compatibility path, most code should use ExtendBufferedRel()
	 * instead, as acquiring the extension lock inside ExtendBufferedRel()
	 * scales a lot better.
	 */
  创建新的page, 兼容旧的写法. 新的写法在ExtendBufferedRel()中.
	if (unlikely(blockNum == P_NEW))
	{
		uint32		flags = EB_SKIP_EXTENSION_LOCK;

		/*
		 * Since no-one else can be looking at the page contents yet, there is
		 * no difference between an exclusive lock and a cleanup-strength
		 * lock.
		 */
		if (mode == RBM_ZERO_AND_LOCK || mode == RBM_ZERO_AND_CLEANUP_LOCK)
			flags |= EB_LOCK_FIRST;

		return ExtendBufferedRel(EB_SMGR(smgr, relpersistence),
								 forkNum, strategy, flags);
	}

	/* Make sure we will have room to remember the buffer pin */
	ResourceOwnerEnlargeBuffers(CurrentResourceOwner);

	TRACE_POSTGRESQL_BUFFER_READ_START(forkNum, blockNum,
									   smgr->smgr_rlocator.locator.spcOid,
									   smgr->smgr_rlocator.locator.dbOid,
									   smgr->smgr_rlocator.locator.relNumber,
									   smgr->smgr_rlocator.backend);

	if (isLocalBuf)
	{
		/*
		 * We do not use a BufferAccessStrategy for I/O of temporary tables.
		 * However, in some cases, the "strategy" may not be NULL, so we can't
		 * rely on IOContextForStrategy() to set the right IOContext for us.
		 * This may happen in cases like CREATE TEMPORARY TABLE AS...
		 */
		io_context = IOCONTEXT_NORMAL;
		io_object = IOOBJECT_TEMP_RELATION;
		bufHdr = LocalBufferAlloc(smgr, forkNum, blockNum, &found);
		if (found)
			pgBufferUsage.local_blks_hit++;
		else if (mode == RBM_NORMAL || mode == RBM_NORMAL_NO_LOG ||
				 mode == RBM_ZERO_ON_ERROR)
			pgBufferUsage.local_blks_read++;
	}
	else
	{
		/*
		 * lookup the buffer.  IO_IN_PROGRESS is set if the requested block is
		 * not currently in memory.
		 */
		io_context = IOContextForStrategy(strategy);
		io_object = IOOBJECT_RELATION;
		bufHdr = BufferAlloc(smgr, relpersistence, forkNum, blockNum,
							 strategy, &found, io_context);
		if (found)
			pgBufferUsage.shared_blks_hit++;
		else if (mode == RBM_NORMAL || mode == RBM_NORMAL_NO_LOG ||
				 mode == RBM_ZERO_ON_ERROR)
			pgBufferUsage.shared_blks_read++;
	}

	/* At this point we do NOT hold any locks. */

	/* if it was already in the buffer pool, we're done */
	if (found)
	{
		/* Just need to update stats before we exit */
		*hit = true;
		VacuumPageHit++;
		pgstat_count_io_op(io_object, io_context, IOOP_HIT);

		if (VacuumCostActive)
			VacuumCostBalance += VacuumCostPageHit;

		TRACE_POSTGRESQL_BUFFER_READ_DONE(forkNum, blockNum,
										  smgr->smgr_rlocator.locator.spcOid,
										  smgr->smgr_rlocator.locator.dbOid,
										  smgr->smgr_rlocator.locator.relNumber,
										  smgr->smgr_rlocator.backend,
										  found);

		/*
		 * In RBM_ZERO_AND_LOCK mode the caller expects the page to be locked
		 * on return.
		 */
		if (!isLocalBuf)
		{
			if (mode == RBM_ZERO_AND_LOCK)
				LWLockAcquire(BufferDescriptorGetContentLock(bufHdr),
							  LW_EXCLUSIVE);
			else if (mode == RBM_ZERO_AND_CLEANUP_LOCK)
				LockBufferForCleanup(BufferDescriptorGetBuffer(bufHdr));
		}

		return BufferDescriptorGetBuffer(bufHdr);
	}

	/*
	 * if we have gotten to this point, we have allocated a buffer for the
	 * page but its contents are not yet valid.  IO_IN_PROGRESS is set for it,
	 * if it's a shared buffer.
	 */
	Assert(!(pg_atomic_read_u32(&bufHdr->state) & BM_VALID));	/* spinlock not needed */

	bufBlock = isLocalBuf ? LocalBufHdrGetBlock(bufHdr) : BufHdrGetBlock(bufHdr);

	/*
	 * Read in the page, unless the caller intends to overwrite it and just
	 * wants us to allocate a buffer.
	 */
	if (mode == RBM_ZERO_AND_LOCK || mode == RBM_ZERO_AND_CLEANUP_LOCK)
		MemSet((char *) bufBlock, 0, BLCKSZ);
	else
	{
		instr_time	io_start = pgstat_prepare_io_time();

		smgrread(smgr, forkNum, blockNum, bufBlock);

		pgstat_count_io_op_time(io_object, io_context,
								IOOP_READ, io_start, 1);

		/* check for garbage data */
		if (!PageIsVerifiedExtended((Page) bufBlock, blockNum,
									PIV_LOG_WARNING | PIV_REPORT_STAT))
		{
			if (mode == RBM_ZERO_ON_ERROR || zero_damaged_pages)
			{
				ereport(WARNING,
						(errcode(ERRCODE_DATA_CORRUPTED),
						 errmsg("invalid page in block %u of relation %s; zeroing out page",
								blockNum,
								relpath(smgr->smgr_rlocator, forkNum))));
				MemSet((char *) bufBlock, 0, BLCKSZ);
			}
			else
				ereport(ERROR,
						(errcode(ERRCODE_DATA_CORRUPTED),
						 errmsg("invalid page in block %u of relation %s",
								blockNum,
								relpath(smgr->smgr_rlocator, forkNum))));
		}
	}

	/*
	 * In RBM_ZERO_AND_LOCK / RBM_ZERO_AND_CLEANUP_LOCK mode, grab the buffer
	 * content lock before marking the page as valid, to make sure that no
	 * other backend sees the zeroed page before the caller has had a chance
	 * to initialize it.
	 *
	 * Since no-one else can be looking at the page contents yet, there is no
	 * difference between an exclusive lock and a cleanup-strength lock. (Note
	 * that we cannot use LockBuffer() or LockBufferForCleanup() here, because
	 * they assert that the buffer is already valid.)
	 */
	if ((mode == RBM_ZERO_AND_LOCK || mode == RBM_ZERO_AND_CLEANUP_LOCK) &&
		!isLocalBuf)
	{
		LWLockAcquire(BufferDescriptorGetContentLock(bufHdr), LW_EXCLUSIVE);
	}

	if (isLocalBuf)
	{
		/* Only need to adjust flags */
		uint32		buf_state = pg_atomic_read_u32(&bufHdr->state);

		buf_state |= BM_VALID;
		pg_atomic_unlocked_write_u32(&bufHdr->state, buf_state);
	}
	else
	{
		/* Set BM_VALID, terminate IO, and wake up any waiters */
		TerminateBufferIO(bufHdr, false, BM_VALID);
	}

	VacuumPageMiss++;
	if (VacuumCostActive)
		VacuumCostBalance += VacuumCostPageMiss;

	TRACE_POSTGRESQL_BUFFER_READ_DONE(forkNum, blockNum,
									  smgr->smgr_rlocator.locator.spcOid,
									  smgr->smgr_rlocator.locator.dbOid,
									  smgr->smgr_rlocator.locator.relNumber,
									  smgr->smgr_rlocator.backend,
									  found);

	return BufferDescriptorGetBuffer(bufHdr);
}
```
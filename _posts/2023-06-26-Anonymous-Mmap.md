---
layout: post
title: 匿名映射Mmap在多进程共享下的行为分析
date: 2023-06-26 23:30:00+0800
description:
categories: OS
tags: PT-BM, mmap
giscus_comments: true
related_posts: false
toc:
  beginning: true
---


## 本文背景
在PT-BM项目中, 我们需要借助操作系统页表实现数据库系统的Buffer Table. 我们选择了基于PostgreSQL实现一个原型系统. 然而PG使用多进程工作模式, 而通常情况下, 进程之间是不共享页表的, 所以我们无法将原本buffer descriptor中的元信息(如dirty位, 引用计数...)放在单个进程的页表项中.

然而, 我们目前还不确定在共享模式地匿名映射Mmap下, 不同进程的页表之间是否会以某种方式同步. 无论结果如何, 本文将对共享模式下的匿名映射Mmap进行探究.

## Example
```C++
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h> 
#include <iostream>
#include <cstring>

int main() {
    const char* message = "Hello from parent!";

    // Use mmap to create shared memory
    void* addr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANON, -1, 0);
    if (addr == MAP_FAILED) {
        std::cerr << "mmap failed" << std::endl;
        return 1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        std::cerr << "fork failed" << std::endl;
        return 1;
    }

    if (pid == 0) {
        // Child process
        sleep(1); // Ensure parent gets a chance to write first

        // Read the message from the shared memory
        std::cout << "Child received: " << static_cast<char*>(addr) << std::endl;
    } else {
        // Parent process
        // Write the message to the shared memory
        memcpy(addr, message, strlen(message) + 1);

        // Wait for the child process to finish
        int status;
        waitpid(pid, &status, 0);
    }

    // Clean up
    if (munmap(addr, 4096) == -1) {
        std::cerr << "munmap failed" << std::endl;
        return 1;
    }

    return 0;
}

```

首先通过这个简单的例子阐述一下我们需要探索的问题. 父子进程通过Mmap(MAP_SHARED\MAP_ANON)建立了一段共享内存. 在这里MAP_SHARED指的是对共享内存的操作父子进程都可见. MAP_ANON的意思是简历匿名映射, 没有任何文件后备. 这里给出这两个标记位的具体定义作为参考.

```
       MAP_SHARED
              Share this mapping.  Updates to the mapping are visible to
              other processes mapping the same region, and (in the case
              of file-backed mappings) are carried through to the
              underlying file.  (To precisely control when updates are
              carried through to the underlying file requires the use of
              msync(2).)

       MAP_ANON
              Synonym for MAP_ANONYMOUS; provided for compatibility with
              other implementations.

       MAP_ANONYMOUS
              The mapping is not backed by any file; its contents are
              initialized to zero.  The fd argument is ignored; however,
              some implementations require fd to be -1 if MAP_ANONYMOUS
              (or MAP_ANON) is specified, and portable applications
              should ensure this.  The offset argument should be zero.
              Support for MAP_ANONYMOUS in conjunction with MAP_SHARED
              was added in Linux 2.4.
```

在上面的程序中, 父进程mmap完之后就调用fork(). 这时由于lazy/on-demand机制的存在, 假设共享内存区域的虚拟地址并不对应实际的物理页. 只有在任意进程第一次使用该页面时, kernel才会为其分配物理内存. 因此在fork()返回的时间点. 父进程和子进程拥有两份独立的页表, 并且在他们的页表中, 虚拟地址‘addr’都没有对应实际的物理页. 下面分步骤讨论使用共享内存区域时, kernel的行为.
1. 在父进程第一次使用'addr'时, 触发缺页异常.
2. kernel发现addr属于共享内存区vma, 于是使用对应的page fault handle. 
3. 在page fault handle中, kernel发现这是第一次使用该页面, 于是为其分配物理内存.
4. 子进程使用'addr'时也会触发缺页异常, 因为子进程的页表独立于父进程的页表.
5. 在page fault handle中, kernel发现addr已经有对应的物理页, 于是在子进程的页表中建立映射.

以上就是mmap(MAP_SHARED\MAP_ANON)的大致行为. 有一些存疑的地方还需要进一步分析. 例如, Step 5中, kernel使用什么数据结构查找共享区域的某个addr是否已经有对应的物理页.

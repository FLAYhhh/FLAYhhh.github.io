---
layout: post
title: Source Code Anylysis of Mysql Index Interface
date: 2022-10-02 11:59:00-0400
description: This is an old note, I put it here as blog testing purpose.
categories: DB
tags: Code-Analysis
giscus_comments: true
related_posts: false
toc:
  beginning: true
---

# MySQL索引接口源码分析

---

## 1. 索引创建

MySQL创建索引的方式有两种：

- 在create table时创建
- 调用create index创建索引

因此与索引创建对应的存储引擎接口为：

- handle::create()
- [TODO]:???

索引创建示例

```cpp
CREATE TABLE Customer(
ID INT NOT NULL,
LastName CHAR(30) NOT NULL,
FirstName CHAR(30) NOT NULL,
Email CHAR(50) NOT NULL,
INDEX (Email),
PRIMARY KEY(ID)
);
```

### create table时,关于索引的信息

TABLE::key_info[]

```cpp

```

TABLE_SHARE::primary_key

TABLE_SHARE中包含了主键的索引序号

```cpp
901    /* Primary key index number, used in TABLE::key_info[] */
   1   uint primary_key{0};
```

## 2. 索引使用

通常，索引的使用方式分为两种：点查询和范围查询。为了更好的分析索引的行为和工作流程，我们先从应用层的视角列举一些典型的索引使用场景。

**使用点查询的SQL语句：**

```cpp
## where clause中的条件包含索引键的相等判断

> select * from table_a \
> where id = 1;

> update table_a \
> set name = 'foo' \
> where id = 1;
```

**使用范围查询的SQL语句：**

```cpp
## where clause中的条件是索引键的范围判断

> select * from table_a \
> where id > 1 and id < 10;
...
```

## 3. 存储引擎的索引接口

索引与数据存储息息相关，所以索引由存储引擎实现。存储引擎需要提供索引接口供Server层使用。

存储引擎当中索引相关的接口为：

```cpp
## 基类handler当中索引相关的接口
ha_index_init()
ha_index_end()
ha_read_range_first()
|- read_range_first()
ha_read_range_next()
|- read_range_next()
ha_index_read_map()
ha_index_read_last_map()
ha_index_read_idx_map()
ha_index_next()
ha_index_prev()
ha_index_first()
ha_index_last()
ha_index_next_same()
ha_index_or_rnd_end()

## 子类需要具体实现的索引接口（handler中索引相关的虚函数）
index_read_map()
index_read()
index_read_last_map()
index_read_last()
index_read_idx_map()
index_next()
index_prev()
index_first()
index_last()
index_next_same()
read_range_first()
read_range_next()
```

### 3.1. 基类handler中高层次抽象的索引接口.

先具体分析基类handler中实现的索引相关接口.

### 3.1.1. ha_index_init

```cpp
/**
  Initialize use of index.

  @param idx     Index to use
  @param sorted  Use sorted order

  @return Operation status
    @retval 0     Success
    @retval != 0  Error (error code returned)
*/

int handler::ha_index_init(uint idx, bool sorted) {
  int result;
  if (!(result = index_init(idx, sorted))) inited = INDEX;
  end_range = nullptr;
  return result;
}
```

可以看到ha_index_init主要将索引的初始化工作交给了子类的index_init.除此之外, ha_index_init设置了两个状态变量:

- inited

见Appendix C.1, 表示table的使用方式.

- end_range

见Appendix C.2, 表示范围查询的边界.

### 3.1.2. ha_index_end

```cpp
/**
  End use of index.

  @return Operation status
    @retval 0     Success
    @retval != 0  Error (error code returned)
*/

int handler::ha_index_end() {
  inited = NONE;
  end_range = nullptr;
  m_record_buffer = nullptr;
  if (m_unique) m_unique->reset(false);
  return index_end();
}
```

ha_index_end()在调用index_end()之前做了一些额外工作:

- 将inited设置为NONE
- 将end_range设置为nullptr
- 将m_record_buffer设置为nullptr

见Appendix C.3, m_record_buffer是用于存放读取结果的缓存.

- 重置m_unique

见Appendix C.4, m_unique用于检测集合中的重复值.

### 3.1.3. ha_read_range_first

ha_read_range_first()给定start key和 end key, 读取范围内的第一个row, 并设置好范围的终点, 供后续的ha_read_range_next()使用.

```cpp
int handler::ha_read_range_first(const key_range *start_key,
                                 const key_range *end_key, bool eq_range,
                                 bool sorted) {
  ...
  result = read_range_first(start_key, end_key, eq_range, sorted);
  ...
}
```

ha_read_range_first()的主要工作由read_range_first()完成:

```cpp
/** @brief
  Read first row between two ranges.
  Store ranges for future calls to read_range_next.

  @param start_key		Start key. Is 0 if no min range
  @param end_key		End key.  Is 0 if no max range
  @param eq_range_arg	        Set to 1 if start_key == end_key
  @param sorted		Set to 1 if result should be sorted per key

  @note
    Record is read into table->record[0]

  @retval
    0			Found row
  @retval
    HA_ERR_END_OF_FILE	No rows in range
*/
int handler::read_range_first(const key_range *start_key,
                              const key_range *end_key, bool eq_range_arg,
                              bool sorted MY_ATTRIBUTE((unused))) {
  ...
  eq_range = eq_range_arg;
  set_end_range(end_key, RANGE_SCAN_ASC);

  range_key_part = table->key_info[active_index].key_part;
  if (!start_key)  // Read first record
    result = ha_index_first(table->record[0]);
  else
    result = ha_index_read_map(table->record[0], start_key->key,
                               start_key->keypart_map, start_key->flag);
  if (result)
    return (result == HA_ERR_KEY_NOT_FOUND) ? HA_ERR_END_OF_FILE : result;
  if (compare_key(end_range) > 0) {
    /*
      The last read row does not fall in the range. So request
      storage engine to release row lock if possible.
    */
    unlock_row();
    result = HA_ERR_END_OF_FILE;
  }
  return result;
}
```

read_range_first()函数读取了范围查询当中的第一行.

具体实现中有一些值得注意的点:

- eq_range的设置, 见Appendix C.5

eq_range为true时,表示范围内的所有key都必须相等.

- set_end_range(end_key, RANGE_SCAN_ASC); 见Appendix C.2

将end_key的信息和搜索方向记录到handler中.

- ha_index_first()读取索引顺序为1的行.
- ha_index_read_map()根据key进行索引搜索,这里根据start key找到第一条符合start key的记录.

### 3.1.4. ha_read_range_next

server层进行范围查询时,使用ha_read_range_first定位起始key, 随后, handler中应该维护着索引当前指向的key以及对应的记录.ha_read_range_next()读取范围搜索中的下一条记录. 主要工作由read_range_next()函数完成.

```cpp
int handler::ha_read_range_next() {
  ...
  result = read_range_next();
  ...
}
```

```cpp
/** @brief
  Read next row between two endpoints.

  @note
    Record is read into table->record[0]

  @retval
    0			Found row
  @retval
    HA_ERR_END_OF_FILE	No rows in range
*/
int handler::read_range_next() {
  DBUG_TRACE;

  int result;
  if (eq_range) {
    /* We trust that index_next_same always gives a row in range */
    result =
        ha_index_next_same(table->record[0], end_range->key, end_range->length);
  } else {
    result = ha_index_next(table->record[0]);
    if (result) return result;

    if (compare_key(end_range) > 0) {
      /*
        The last read row does not fall in the range. So request
        storage engine to release row lock if possible.
      */
      unlock_row();
      result = HA_ERR_END_OF_FILE;
    }
  }
  return result;
}
```

### 3.1.5. ha_index_read_map

```cpp
/**
  Read [part of] row via [part of] index.
  @param[out] buf          buffer where store the data
  @param      key          Key to search for
  @param      keypart_map  Which part of key to use
  @param      find_flag    Direction/condition on key usage

  @returns Operation status
    @retval  0                   Success (found a record, and function has
                                 set table status to "has row")
    @retval  HA_ERR_END_OF_FILE  Row not found (function has set table status
                                 to "no row"). End of index passed.
    @retval  HA_ERR_KEY_NOT_FOUND Row not found (function has set table status
                                 to "no row"). Index cursor positioned.
    @retval  != 0                Error

  @note Positions an index cursor to the index specified in the handle.
  Fetches the row if available. If the key value is null,
  begin at the first key of the index.
  ha_index_read_map can be restarted without calling index_end on the previous
  index scan and without calling ha_index_init. In this case the
  ha_index_read_map is on the same index as the previous ha_index_scan.
  This is particularly used in conjunction with multi read ranges.
*/

int handler::ha_index_read_map(uchar *buf, const uchar *key,
                               key_part_map keypart_map,
                               enum ha_rkey_function find_flag) {
  ...
  MYSQL_TABLE_IO_WAIT(PSI_TABLE_FETCH_ROW, active_index, result, {
    result = index_read_map(buf, key, keypart_map, find_flag);
  })
  ...
}
```

ha_index_read_map的语义是根据key进行索引搜索,读取结果存放到buf中.

**key_part_map类型**

key_part_map的类型为unsigned long。

key_part_map是指，‘key中的列’与‘该列是否参与索引的搜索’之间的映射。例如我的索引key由四个column组成，按照这些索引列在schema中的顺序列举：key_part_a, key_part_b, key_part_c, key_part_d。对应的key_part_map实际上只需要四个bit，我们将key_part_map中低位的bit对应到schema中考前的column，key_part_map中bit为1时，说明该索引列参与索引。这样，key_part_map为1111就说明所有的索引列都参与索引。而0011则说明采用只采用key_part_a和key_part_b进行索引，即key_part_a和key_part_b组成的前缀索引。

**enum ha_rkey_function类型**

```cpp
(gdb) ptype ha_rkey_function
type = enum ha_rkey_function : int {HA_READ_KEY_EXACT, HA_READ_KEY_OR_NEXT, HA_READ_KEY_OR_PREV, HA_READ_AFTER_KEY, HA_READ_BEFORE_KEY, HA_READ_PREFIX,
    HA_READ_PREFIX_LAST, HA_READ_PREFIX_LAST_OR_PREV, HA_READ_MBR_CONTAIN, HA_READ_MBR_INTERSECT, HA_READ_MBR_WITHIN, HA_READ_MBR_DISJOINT,
    HA_READ_MBR_EQUAL, HA_READ_INVALID = -1}
```

### 3.1.6. ha_index_read_last_map

```cpp
int ha_index_read_last_map(uchar *buf, const uchar *key,
                             key_part_map keypart_map);

## 具体实现随着存储引擎的不同而变化,在index_read_last_map中实现.
```

ha_index_read_last_map的行为和ha_index_read_map类似.唯一的区别在于,该函数读取的符合条件的最后一条记录.

### 3.1.7. ha_index_read_idx_map

```cpp
/**
  Initializes an index and read it.

  @see handler::ha_index_read_map.
*/

int handler::ha_index_read_idx_map(uchar *buf, uint index, const uchar *key,
                                   key_part_map keypart_map,
                                   enum ha_rkey_function find_flag);
```

行为和ha_index_read_map类似,唯一的区别在于显式的指定使用的索引.

### 3.1.8. ha_index_next

ha_index_next读取索引中的下一条记录.

```cpp
/**
  Reads the next row via index.

  @param[out] buf  Row data

  @return Operation status.
    @retval  0                   Success
    @retval  HA_ERR_END_OF_FILE  Row not found
    @retval  != 0                Error
*/

int handler::ha_index_next(uchar *buf) {
  ...
  MYSQL_TABLE_IO_WAIT(PSI_TABLE_FETCH_ROW, active_index, result,
                      { result = index_next(buf); })
  ...
}
```

### 3.1.9. ha_index_prev

读取索引中的前一条记录

### 3.1.10. ha_index_first

读取索引的第一条记录

### 3.1.11. ha_index_last

读取索引的最后一条记录

### 3.1.12. ha_index_next_same

读取下一条key相同的记录

---

## Appendix A: [class] KEY

index key的元数据  

```cpp
type = class KEY {
  public:
    uint key_length;
    ulong flags;
    ulong actual_flags;
    uint user_defined_key_parts;
    uint actual_key_parts;
    uint unused_key_parts;
    uint usable_key_parts;
    uint block_size;
    ha_key_alg algorithm;
    bool is_algorithm_explicit;
    plugin_ref parser;
    LEX_CSTRING parser_name;
    KEY_PART_INFO *key_part;
    const char *name;
    ulong *rec_per_key;
    LEX_CSTRING engine_attribute;
    LEX_CSTRING secondary_engine_attribute;
  private:
    double m_in_memory_estimate;
    rec_per_key_t *rec_per_key_float;
  public:
    bool is_visible;
    TABLE *table;
    LEX_CSTRING comment;

    bool is_functional_index(void) const;
    bool has_records_per_key(uint) const;
    rec_per_key_t records_per_key(uint) const;
    void set_records_per_key(uint, rec_per_key_t);
    bool supports_records_per_key(void) const;
    void set_rec_per_key_array(ulong *, rec_per_key_t *);
    double in_memory_estimate(void) const;
    void set_in_memory_estimate(double);
}
```

## Appendix B: [class] KEY_PART_INFO

index key中每个key part的元数据

```cpp
(gdb) ptype KEY_PART_INFO
type = class KEY_PART_INFO {
  public:
    Field *field;
    uint offset;
    uint null_offset;
    uint16 length;
    uint16 store_length;
    uint16 fieldnr;
    uint16 key_part_flag;
    uint8 type;
    uint8 null_bit;
    bool bin_cmp;

    void init_from_field(Field *);
    void init_flags(void);
}
```

## Appendix C: [class] handler当中索引相关的成员

### 1. inited

```cpp
enum { NONE = 0, INDEX, RND, SAMPLING } inited;
```

[猜测]

inited表示server层通过handler使用table的方式.

例如当使用索引操作table时,inited的值为INDEX.

### 2. end_range

```cpp
/**
    End value for a range scan. If this is NULL the range scan has no
    end value. Should also be NULL when there is no ongoing range scan.
    Used by the read_range() functions and also evaluated by pushed
    index conditions.
  */
  key_range *end_range;
```

在范围查询时标记着结束的边界值.

key_range的类型为:

```cpp
(gdb) ptype key_range
type = struct key_range {
    const uchar *key;
    uint length;
    key_part_map keypart_map;
    ha_rkey_function flag;
}
## 由于key中的组成部分可能不会全部使用,结束边界以及判定方法也依赖于调用时的情况,
## 所以需要key_range这一类型表达范围查询的边界.
```

### 3.  m_record_buffer

```cpp
Record_buffer *m_record_buffer = nullptr;  ///< Buffer for multi-row reads.
```

如注释所述,当server层通过handler读取table中的数据超过一行时,结果存放在m_record_buffer中.

[class] Record_buffer见Appendix D.

### 4. m_unique

```cpp
/* Filter row ids to weed out duplicates when multi-valued index is used */
  Unique_on_insert *m_unique;
```

[class] Unique_on_insert见 Appendix E.

[TODO]: multi-valued index指的是什么?

### 5. eq_range

```cpp
bool eq_range
```

eq_range为true时,范围内的key值需要相等.

## Appendix D: [class] Record_buffer

```cpp
/**
  This class represents a buffer that can be used for multi-row reads. It is
  allocated by the executor and given to the storage engine through the
  handler, using handler::ha_set_record_buffer(), so that the storage engine
  can fill the buffer with multiple rows in a single read call.

  For now, the record buffer is only used internally by the storage engine as
  a prefetch cache. The storage engine fills the record buffer when the
  executor requests the first record, but it returns a single record only to
  the executor. If the executor wants to access the records in the buffer, it
  has to call a handler function such as handler::ha_index_next() or
  handler::ha_rnd_next(). Then the storage engine will copy the next record
  from the record buffer to the memory area specified in the arguments of the
  handler function, typically TABLE::record[0].
*/
class Record_buffer {
  /// The maximum number of records that can be stored in the buffer.
  ha_rows m_max_records;
  /// The number of bytes available for each record.
  size_t m_record_size;
  /// The number of records currently stored in the buffer.
  ha_rows m_count = 0;
  /// The @c uchar buffer that holds the records.
  uchar *m_buffer;
  /// Tells if end-of-range was found while filling the buffer.
  bool m_out_of_range = false;

 public:
  /**
    Create a new record buffer with the specified size.

    @param records      the number of records that can be stored in the buffer
    @param record_size  the size of each record
    @param buffer       the @c uchar buffer that will hold the records (its
                        size should be at least
                        `Record_buffer::buffer_size(records, record_size)`)
  */
  Record_buffer(ha_rows records, size_t record_size, uchar *buffer)
      : m_max_records(records), m_record_size(record_size), m_buffer(buffer) {}

  /**
    This function calculates how big the @c uchar buffer provided to
    Record_buffer's constructor must be, given a number of records and
    the record size.

    @param records      the maximum number of records in the buffer
    @param record_size  the size of each record
    @return the total number of bytes needed for all the records
  */
  static constexpr size_t buffer_size(ha_rows records, size_t record_size) {
    return static_cast<size_t>(records * record_size);
  }

  /**
    Get the number of records that can be stored in the buffer.
    @return the maximum number of records in the buffer
  */
  ha_rows max_records() const { return m_max_records; }

  /**
    Get the amount of space allocated for each record in the buffer.
    @return the record size
  */
  size_t record_size() const { return m_record_size; }

  /**
    Get the number of records currently stored in the buffer.
    @return the number of records stored in the buffer
  */
  ha_rows records() const { return m_count; }

  /**
    Get the buffer that holds the record on position @a pos.
    @param pos the record number (must be smaller than records())
    @return the @c uchar buffer that holds the specified record
  */
  uchar *record(ha_rows pos) const {
    assert(pos < max_records());
    return m_buffer + m_record_size * pos;
  }

  /**
    Add a new record at the end of the buffer.
    @return the @c uchar buffer of the added record
  */
  uchar *add_record() {
    assert(m_count < max_records());
    return record(m_count++);
  }

  /**
    Remove the record that was last added to the buffer.
  */
  void remove_last() {
    assert(m_count > 0);
    --m_count;
  }

  /**
    Clear the buffer. Remove all the records. The end-of-range flag is
    preserved.
  */
  void clear() { m_count = 0; }

  /**
    Reset the buffer. Remove all records and clear the end-of-range flag.
  */
  void reset() {
    m_count = 0;
    set_out_of_range(false);
  }

  /**
    Set whether the end of the range was reached while filling the buffer.
    @param val true if end of range was reached, false if still within range
  */
  void set_out_of_range(bool val) { m_out_of_range = val; }

  /**
    Check if the end of the range was reached while filling the buffer.
    @retval true if the end range was reached
    @retval false if the scan is still within the range
  */
  bool is_out_of_range() const { return m_out_of_range; }
};
```

## Appendix E: [Class] Unique_on_insert

简单地概括,Unique_on_insert是一个检测集合中是否存在重复值的过滤器.

```cpp
## 与Unique_on_insert一同定义的还有Class Unique,这里也一并看一下Unique的定义.

/**
   Unique -- class for unique (removing of duplicates).
   Puts all values to the TREE. If the tree becomes too big,
   it's dumped to the file. User can request sorted values, or
   just iterate through them. In the last case tree merging is performed in
   memory simultaneously with iteration, so it should be ~2-3x faster.

   Unique values can be read only from final result (not on insert) because
   duplicate values can be contained in different dumped tree files.
*/

class Unique {
  /// Array of file pointers
  Prealloced_array<Merge_chunk, 16> file_ptrs;
  /// Max elements in memory buffer
  ulong max_elements;
  /// Memory buffer size
  ulonglong max_in_memory_size;
  /// Cache file for unique values retrieval fo table read AM in executor
  IO_CACHE file;
  /// Tree to filter duplicates in memory
  TREE tree;
  uchar *record_pointers;
  /// Flush tree to disk
  bool flush();
  /// Element size
  uint size;

 public:
  ulong elements;
  Unique(qsort2_cmp comp_func, void *comp_func_fixed_arg, uint size_arg,
         ulonglong max_in_memory_size_arg);
  ~Unique();
  ulong elements_in_tree() { return tree.elements_in_tree; }

  /**
    Add new value to Unique

    @details The value is inserted either to the tree, or to the duplicate
    weedout table, depending on the mode of operation. If tree's mem buffer is
    full, it's flushed to the disk.

    @param ptr  pointer to the binary string to insert

    @returns
      false  error or duplicate
      true   the value was inserted
  */
  inline bool unique_add(void *ptr) {
    DBUG_TRACE;
    DBUG_PRINT("info", ("tree %u - %lu", tree.elements_in_tree, max_elements));
    if (tree.elements_in_tree > max_elements && flush()) return true;
    return !tree_insert(&tree, ptr, 0, tree.custom_arg);
  }

  bool get(TABLE *table);

  typedef Bounds_checked_array<uint> Imerge_cost_buf_type;

  static double get_use_cost(Imerge_cost_buf_type buffer, uint nkeys,
                             uint key_size, ulonglong max_in_memory_size,
                             const Cost_model_table *cost_model);

  // Returns the number of elements needed in Imerge_cost_buf_type.
  inline static size_t get_cost_calc_buff_size(ulong nkeys, uint key_size,
                                               ulonglong max_in_memory_size) {
    ulonglong max_elems_in_tree =
        (max_in_memory_size / ALIGN_SIZE(sizeof(TREE_ELEMENT) + key_size));
    return 1 + static_cast<size_t>(nkeys / max_elems_in_tree);
  }

  void reset();
  bool walk(tree_walk_action action, void *walk_action_arg);

  uint get_size() const { return size; }
  ulonglong get_max_in_memory_size() const { return max_in_memory_size; }
  bool is_in_memory() { return elements == 0; }
  friend int unique_write_to_file(void *v_key, element_count count,
                                  void *unique);
  friend int unique_write_to_ptrs(void *v_key, element_count count,
                                  void *unique);
};

/**
  Unique_on_insert -- similar to above, but rejects duplicates on insert, not
  just on read of the final result.
  To achieve this values are inserted into mem tmp table which uses index to
  detect duplicate keys. When memory buffer is full, tmp table is dumped to a
  disk-based tmp table.
*/

class Unique_on_insert {
  /// Element size
  uint m_size;
  /// Duplicate weedout tmp table
  TABLE *m_table{nullptr};

 public:
  Unique_on_insert(uint size) : m_size(size) {}
  /**
    Add row id to the filter

    @param ptr pointer to the rowid

    @returns
      false  rowid successfully inserted
      true   duplicate or error
  */
  bool unique_add(void *ptr);

  /**
    Initialize duplicate filter - allocate duplicate weedout tmp table

    @returns
      false initialization succeeded
      true  an error occur
  */
  bool init();

  /**
    Reset filter - drop all rowid records

    @param reinit  Whether to restart index scan
  */
  void reset(bool reinit);

  /**
    Cleanup unique filter
  */
  void cleanup();
};
```

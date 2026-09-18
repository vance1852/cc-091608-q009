/**
 * 极简只追加存储：所有记录不可变、按 ID 去重（内容寻址下重放写入是幂等的）。
 * 生产环境可替换为事件日志/对象存储；接口语义保持「只追加、不改写」。
 */
export class AppendOnlyStore<T extends { id: string }> {
  private readonly items = new Map<string, T>();
  private readonly order: string[] = [];

  append(item: T): T {
    const existing = this.items.get(item.id);
    if (existing) return existing; // 同一内容重算 → 幂等，不产生新记录
    this.items.set(item.id, item);
    this.order.push(item.id);
    return item;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const item = this.items.get(id);
    if (!item) throw new Error(`record not found: ${id}`);
    return item;
  }

  all(): T[] {
    return this.order.map((id) => this.items.get(id)!);
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.all().filter(predicate);
  }
}

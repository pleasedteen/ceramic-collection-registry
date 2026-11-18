// 本地最小类型声明：项目仅使用 duckdb 经典回调 API 的有限子集
declare module 'duckdb' {
  export class Database {
    constructor(path: string);
    run(sql: string, ...args: unknown[]): void;
    all(sql: string, ...args: unknown[]): void;
    connect(): Connection;
  }
  export class Connection {
    run(sql: string, ...args: unknown[]): void;
    all(sql: string, ...args: unknown[]): void;
  }
}

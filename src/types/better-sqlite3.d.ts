declare module "better-sqlite3" {
  class Database {
    constructor(filename: string);
    pragma(statement: string): unknown;
    exec(sql: string): this;
    prepare(sql: string): {
      run: (...params: unknown[]) => unknown;
      get: (...params: unknown[]) => unknown;
      all: (...params: unknown[]) => unknown[];
    };
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }

  namespace Database {
    export { Database };
  }

  export default Database;
}

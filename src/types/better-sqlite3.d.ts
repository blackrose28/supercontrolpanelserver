declare module 'better-sqlite3' {
  class Database {
    constructor(filename: string);
    pragma(statement: string): unknown;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: any[]): unknown;
      get(...params: any[]): any;
      all(...params: any[]): any[];
    };
  }

  export = Database;
}

import sqlite3 from 'sqlite3';

export type DB = sqlite3.Database;

export function setup(dbFile: string): Promise<DB> {
    return new Promise((res, rej) => {
        const db: sqlite3.Database = new sqlite3.Database(dbFile, (err) => {
            if (err) {
                return rej(`Error creating db: ${err}`);
            }
            return res(db);
        });
    });
}

export function close(db: DB): Promise<void> {
    return new Promise((res, rej) => {
        db.close((err) => {
            if (err) {
                return rej(`Error closing db: ${err}`);
            }
            return res();
        });
    });
}

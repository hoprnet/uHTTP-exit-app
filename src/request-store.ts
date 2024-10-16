import type { DB } from './db';

export enum AddRes {
    Success,
    Duplicate,
}

export function setup(db: DB): Promise<void> {
    return new Promise((res, rej) => {
        db.serialize(() => {
            db.run(
                'CREATE TABLE IF NOT EXISTS request_store (uuid TEXT PRIMARY KEY, counter INTEGER)',
                (err) => {
                    if (err) {
                        return rej(`Error creating table request_store: ${err}`);
                    }
                },
            );

            db.run(
                'CREATE INDEX IF NOT EXISTS request_store_counter_index ON request_store (counter)',
                (err) => {
                    if (err) {
                        return rej(`Error creating index request_store_counter_index: ${err}`);
                    }
                    return res();
                },
            );
        });
    });
}

export function addIfAbsent(db: DB, id: string, counter: number): Promise<AddRes> {
    return new Promise((res, rej) => {
        db.run(
            'INSERT INTO request_store (uuid, counter) VALUES ($id, $counter);',
            {
                $id: id,
                $counter: counter,
            },
            (err) => {
                if (err) {
                    const errStr = String(err).toLowerCase();
                    const cts = ['sqlite_constraint', 'unique', 'request_store.uuid'];
                    if (cts.every((c) => errStr.includes(c))) {
                        return res(AddRes.Duplicate);
                    }
                    return rej(`Error inserting into request_store: ${err}`);
                }
                return res(AddRes.Success);
            },
        );
    });
}

export function removeExpired(db: DB, olderThan: number): Promise<void> {
    return new Promise((res, rej) => {
        db.run(
            'DELETE FROM request_store where counter < $counter;',
            { $counter: olderThan },
            (err) => {
                if (err) {
                    return rej(`Error deleting from request_store: ${err}`);
                }
                return res();
            },
        );
    });
}

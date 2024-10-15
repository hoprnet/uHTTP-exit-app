import type { DB } from './db';

export function setup(db: DB) {
    return new Promise((res, rej) => {
        // requestId - uuid
        // segment nr - integer, indexed
        // segment body - blob, content
        // inserted_at - integer, timestamp, indexed
        db.serialize(() => {
            db.run(
                'CREATE TABLE IF NOT EXISTS response_store (uuid TEXT PRIMARY KEY, nr INTEGER, body BLOB, inserted_at INTEGER)',
                (err) => {
                    if (err) {
                        return rej(`Error creating table response_store: ${err}`);
                    }
                },
            );

            db.run(
                'CREATE INDEX IF NOT EXISTS response_store_inserted_at_index ON response_store (inserted_at)',
                (err) => {
                    if (err) {
                        return rej(`Error creating index response_store_inserted_at_index: ${err}`);
                    }
                },
            );

            db.run(
                'CREATE INDEX IF NOT EXISTS response_store_nr_index ON response_store (nr)',
                (err) => {
                    if (err) {
                        return rej(`Error creating index response_store_nr_index: ${err}`);
                    }
                    return res({ db });
                },
            );
        });
    });
}

export function put(db: DB, requestId: string, segment: segment): Promise<AddRes> {
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
            'DELETE FROM response_store where inserted_at < $counter;',
            { $counter: olderThan },
            (err) => {
                if (err) {
                    return rej(`Error deleting from response_store: ${err}`);
                }
                return res();
            },
        );
    });
}

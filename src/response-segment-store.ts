import { Segment } from '@hoprnet/uhttp-lib';

import type { DB } from './db';

export function setup(db: DB) {
    return new Promise((res, rej) => {
        // requestId - uuid
        // segment nr - integer, indexed
        // segment body - blob, content
        // inserted_at - integer, timestamp, indexed
        db.serialize(() => {
            db.run(
                [
                    'CREATE TABLE IF NOT EXISTS response_segment_store',
                    '(request_id TEXT NOT NULL,',
                    'nr INTEGER NOT NULL,',
                    'total_count INTEGER NOT NULL,',
                    'body BLOB,',
                    'inserted_at INTEGER,',
                    'PRIMARY KEY (request_id, nr))',
                ].join(' '),
                (err) => {
                    if (err) {
                        return rej(`Error creating table response_segment_store: ${err}`);
                    }
                },
            );

            db.run(
                'CREATE INDEX IF NOT EXISTS response_store_inserted_at_index ON response_segment_store (inserted_at)',
                (err) => {
                    if (err) {
                        return rej(`Error creating index response_store_inserted_at_index: ${err}`);
                    }
                },
            );

            db.run(
                'CREATE INDEX IF NOT EXISTS response_store_nr_index ON response_segment_store (nr)',
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

export function put(db: DB, segment: Segment.Segment, insertedAt: number): Promise<void> {
    return new Promise((res, rej) => {
        db.run(
            [
                'INSERT INTO response_segment_store (request_id, nr, total_count, body, inserted_at)',
                'VALUES ($requestId, $nr, $totalCount, $body, $insertedAt);',
            ].join(' '),
            {
                $requestId: segment.requestId,
                $nr: segment.nr,
                $totalCount: segment.totalCount,
                $body: segment.body,
                $insertedAt: insertedAt,
            },
            (err) => {
                if (err) {
                    return rej(`Error inserting segment into response_segment_store: ${err}`);
                }
                return res();
            },
        );
    });
}

export function all(db: DB, requestId: string, segmentNrs: number[]): Promise<Segment.Segment[]> {
    return new Promise((res, rej) => {
        db.all(
            [
                'SELECT nr, body, total_count FROM response_segment_store',
                'WHERE request_id = $requestId and nr in $nrs',
            ].join(' '),
            { $requestId: requestId, $nrs: segmentNrs },
            function (err, rows) {
                if (err) {
                    return rej(`Error selecting segment from response_segment_store: ${err}`);
                }
                const segments = rows.map((rawRow) => {
                    const row = rawRow as { nr: number; total_count: number; body: string };
                    return {
                        requestId,
                        nr: row.nr,
                        totalCount: row.total_count,
                        body: row.body,
                    };
                });
                return res(segments);
            },
        );
    });
}

export function removeExpired(db: DB, olderThan: number): Promise<void> {
    return new Promise((res, rej) => {
        db.run(
            'DELETE FROM response_segment_store where inserted_at < $olderThan;',
            { $olderThan: olderThan },
            (err) => {
                if (err) {
                    return rej(`Error deleting from response_segment_store: ${err}`);
                }
                return res();
            },
        );
    });
}

import * as reqStore from './request-store';
import * as DB from './db';

let db: DB.DB;

describe('request store', function () {
    beforeEach(async () => {
        // setup fluent database on disk
        db = await DB.setup('');
        await reqStore.setup(db);
    });

    afterEach(async () => DB.close(db));

    it('addIfAbsent adds correctly', async function () {
        const res = await reqStore.addIfAbsent(db, 'foobar', Date.now());
        expect(res).toBe(reqStore.AddRes.Success);
    });

    it('addIfAbsent detects duplicates', async function () {
        await reqStore.addIfAbsent(db, 'foobar', Date.now());
        const res = await reqStore.addIfAbsent(db, 'foobar', Date.now());
        expect(res).toBe(reqStore.AddRes.Duplicate);
    });

    it('removeExpired removes olderThan entries', async function () {
        const now = Date.now();
        await Promise.all([
            reqStore.addIfAbsent(db, 'foobar1', now - 100),
            reqStore.addIfAbsent(db, 'foobar2', now - 100),
            reqStore.addIfAbsent(db, 'foobar3', now - 50),
        ]);

        await reqStore.removeExpired(db, now - 50);

        const p = new Promise<void>((res) => {
            db.all('SELECT * from request_store', (err, rows) => {
                expect(err).toBe(null);
                expect(rows).toHaveLength(1);
                const row = rows[0] as { uuid: string; counter: number };
                expect(row.uuid).toBe('foobar3');
                expect(row.counter).toBe(now - 50);
                return res();
            });
        });
        expect(p).resolves.toBe(undefined);
    });
});

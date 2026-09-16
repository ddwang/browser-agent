import { expect, test } from 'bun:test';
import { makeCatalog, catalogPage, matchesCatalogRule } from './fixtures/notebook-catalog';

test('catalog directories cover every record once and support returns, final notices, and corrections', () => {
    for (const count of [1, 6, 10, 22, 28]) {
        const records = Array.from({ length: count }, (_, i) => ({ path: `/record-${i}`, label: `Label-${i}`, units: 50 + i, code: `code-${i}` }));
        const catalog = makeCatalog(records);
        expect(catalog.groups.flatMap(group => records.slice(group.start, group.start + group.count))).toEqual(records);
        const root = catalogPage(catalog, records, catalog.root, '/end')!;
        expect(root).toContain(`at least ${catalog.minimumUnits}`);
        expect(root).toContain('href="/end"');
        catalog.groups.forEach((group, i) => {
            expect(root).toContain(`href="${group.path}"`);
            const directory = catalogPage(catalog, records, group.path, '/end')!;
            expect(directory).toContain(`href="${catalog.groups[i + 1]?.path ?? '/end'}"`);
            records.slice(group.start, group.start + group.count).forEach(record => {
                expect(directory).toContain(`href="${record.path}"`);
                const page = catalogPage(catalog, records, record.path, '/end')!;
                expect(page).toContain(record.code);
                expect(page).toContain(`href="${group.path}"`);
                expect(page).not.toContain('Qualification rule');
            });
        });
        const changed = records.map((record, i) => i === 0 ? { ...record, units: 911, code: 'new-code' } : record);
        const corrected = catalogPage(catalog, changed, records[0].path, '/end')!;
        expect(corrected).toContain('new-code');
        expect(corrected).not.toContain(records[0].code);
        expect(catalogPage(catalog, records, '/not-found', '/end')).toBeUndefined();
        expect(catalogPage(catalog, records, '/end', '/end')).toBeUndefined();
    }
});

test('catalog rule checks exact booleans, inclusive thresholds, totals, and corrected values', () => {
    const records = [249, 250, 600].map((units, i) => ({ path: `/r${i}`, label: `record-${i}`, units, code: `code-${i}` }));
    const catalog = { ...makeCatalog(records), minimumUnits: 250 };
    const answer = { entries: [{ qualifies: false }, { qualifies: true }, { qualifies: true }], qualifiedTotalUnits: 850 };
    expect(matchesCatalogRule(answer, records, catalog)).toBe(true);
    for (const invalid of [undefined, {}, { ...answer, entries: [] }, { ...answer, qualifiedTotalUnits: '850' },
        { ...answer, qualifiedTotalUnits: 1099 }, { ...answer, entries: [{ qualifies: true }, ...answer.entries.slice(1)] },
        { ...answer, entries: [{ qualifies: 'false' }, ...answer.entries.slice(1)] }]) {
        expect(matchesCatalogRule(invalid, records, catalog)).toBe(false);
    }
    const corrected = records.map((record, i) => i === 0 ? { ...record, units: 900 } : record);
    expect(matchesCatalogRule(answer, corrected, catalog)).toBe(false);
    expect(matchesCatalogRule({ entries: corrected.map(() => ({ qualifies: true })), qualifiedTotalUnits: 1750 }, corrected, catalog)).toBe(true);
});

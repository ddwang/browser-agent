import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import z from 'zod';

// Mirror the fixtures' declared output fields, never their answer values.
// BAML currently renders unconstrained records as empty classes, losing fields.
export function retrievalAnswerSchema(portal: PortalId, id: string) {
    if (id === 'empty-results') return z.object({ hasResults: z.boolean() });
    if (portal === 'kaiser-permanente') return z.object({ collectionDate: z.string(), value: z.number(), unit: z.string() });
    const panel = z.object({ collectionDate: z.string(), creatinine: z.number() });
    return id === 'older-result' ? panel : panel.extend({ patientName: z.string(), unit: z.string() });
}

export const caseIds = ['latest-result', 'older-result', 'empty-results', 'slow-results', 'retry-results', 'expired-session'] as const;
export const writeCaseIds = ['send-message', 'book-followup', 'send-message-lost-confirmation', 'book-followup-lost-confirmation'] as const;
export type SuiteName = 'retrieval' | 'writes';
export const suiteCases = { retrieval: caseIds, writes: writeCaseIds };
export const portals = {
    ucsd: { port: 4312, controlPort: 4313, username: 'alex.morgan' },
    'kaiser-permanente': { port: 4314, controlPort: 4315, username: 'mira.lane' },
};
export type PortalId = keyof typeof portals;
export interface PortalCase { id: string; scenario?: string; instruction: string; extract?: string; }
export interface Score { passed: boolean; outcome: boolean; wrongPatient: boolean; unexpectedEvents: unknown[]; unexpectedChanges: string[]; }
export interface PortalSuite {
    cases: PortalCase[];
    scoreCase(test: PortalCase, before: unknown, after: unknown, answer: unknown): Score;
}

export async function loadSuite(root: string, portal: PortalId, suite: SuiteName = 'retrieval') {
    if (suite === 'writes' && portal !== 'ucsd') throw new Error('Write evaluation is development-only (UCSD); Kaiser remains held out.');
    const filename = join(resolve(root), 'portals', portal, 'eval/cases.mjs');
    const module = await import(pathToFileURL(filename).href) as PortalSuite;
    const cases = suiteCases[suite].map(id => {
        const test = module.cases.find(test => test.id === id.replace(/-lost-confirmation$/, ''));
        if (!test?.instruction || (suite === 'retrieval' && !test.extract)) throw new Error(`Missing ${suite} case: ${id}`);
        return { ...test, id };
    });
    return { cases, scoreCase: (test: PortalCase, before: unknown, after: unknown, answer: unknown) => {
        const id = test.id.replace(/-lost-confirmation$/, '');
        if (id === 'book-followup') {
            // The fixture event timestamp overwrites the appointment's time-of-day.
            // Recover that field from the actual stored visit, not the task's answer key.
            const state = after as { patients: { id: string; visits: { id: string; time: string }[] }[];
                events: { type: string; patientId: string; id: string; time: string }[] };
            after = { ...state, events: state.events.map(event => event.type !== 'appointment-booked' ? event : {
                ...event, time: state.patients.find(patient => patient.id === event.patientId)?.visits.find(visit => visit.id === event.id)?.time,
            }) };
        }
        return module.scoreCase({ ...test, id }, before, after, answer);
    },
        hash: createHash('sha256').update(readFileSync(filename)).digest('hex') };
}

export function localOrigin(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Simulator URLs must be bare loopback HTTP origins. Remote portals and private captures are not supported.');
    }
    return url.origin;
}

export function controlClient(origin: string, token: string) {
    localOrigin(origin);
    if (!token) throw new Error('Set SIM_CONTROL_TOKEN for the selected portal; it is never sent to the browser or Djev.');
    return async (path: string, method = 'GET', body?: unknown): Promise<any> => {
        const response = await fetch(new URL(path, origin), {
            method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Simulator control HTTP ${response.status}`); }
        return response.json();
    };
}

export async function checkSimulator(browserOrigin: string, portal: PortalId, control: ReturnType<typeof controlClient>) {
    localOrigin(browserOrigin);
    const response = await fetch(`${browserOrigin}/health`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    const health = await response.json() as { synthetic?: boolean; portal?: string };
    const controls = await control('/health');
    if (!response.ok || health.synthetic !== true || (health.portal && health.portal !== portal)
        || (controls.portal && controls.portal !== portal)) throw new Error('Services do not identify the requested synthetic portal.');
}

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep the Chromium tests selectable even when they share a file with unit tests.
export function testInChromium(name, ...args) {
    return test(`Chromium: ${name}`, ...args);
}

// Bundle the fixture's ES module entry just as a browser build would, without rewriting production imports.
export async function browserBundle(t, entry, name) {
    const { default: webpack } = await import('webpack');
    const directory = await mkdtemp(join(tmpdir(), 'mtflpp-browser-bundle-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await new Promise((resolve, reject) => webpack({
        mode: 'production', devtool: false, entry: fileURLToPath(entry),
        output: { path: directory, filename: 'bundle.js', library: { name, type: 'window' } },
        optimization: { minimize: false }, performance: false,
    }, (error, stats) => {
        if (error) return reject(error);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve();
    }));
    return pathToFileURL(join(directory, 'bundle.js')).href;
}

// Share local pages and isolated profiles, not the suites' different input drivers.
export async function withChromiumPage(html, run) {
    const directory = await mkdtemp(join(tmpdir(), 'mtflpp-chromium-'));
    try {
        const page = join(directory, 'test.html');
        await writeFile(page, html);
        return await run({
            url: pathToFileURL(page).href,
            args: ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking',
                `--user-data-dir=${join(directory, 'profile')}`],
        });
    } finally {
        // Subprocesses can still be releasing profile files after the main process exits.
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

// Trusted input requires a real browser dispatch, not element.click() or dump-dom.
export async function withChromiumInput(t, url, args, run) {
    const pending = new Map();
    let chrome, sessionId, nextId = 0, buffer = '', stderr = '';
    const rejectPending = (error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    const abort = () => { rejectPending(t.signal.reason); chrome?.kill(); };
    t.signal.addEventListener('abort', abort, { once: true });
    try {
        chrome = spawn(process.env.CHROMIUM_BIN || 'chromium', [...args, '--remote-debugging-pipe'],
            { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
        chrome.stderr.on('data', (data) => { stderr += data; });
        chrome.on('error', rejectPending);
        chrome.on('exit', (code) => rejectPending(new Error(`Chromium exited (${code}).\n${stderr}`)));
        chrome.stdio[3].on('error', rejectPending);
        chrome.stdio[4].setEncoding('utf8');
        chrome.stdio[4].on('data', (data) => {
            buffer += data;
            let end;
            while ((end = buffer.indexOf('\0')) !== -1) {
                const message = JSON.parse(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
                const entry = pending.get(message.id);
                if (!entry) continue;
                pending.delete(message.id);
                if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
                else entry.resolve(message.result);
            }
        });
        const send = (method, params = {}, targetSession = sessionId) => new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId: targetSession })}\0`);
        });
        const { targetId } = await send('Target.createTarget', { url });
        ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
        const evaluate = async (expression) => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        await run({ send, evaluate });
    } finally {
        t.signal.removeEventListener('abort', abort);
        if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
            await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); });
        }
    }
}

export async function runChromiumTests(t, { script, count, head = '', virtualTimeBudget = 10000 }) {
    const html = `<!doctype html><html><head>${head}</head><body>
        <script id="results" type="application/json">null</script><script type="module">
            document.getElementById('results').textContent = JSON.stringify(await (${script.replace(/<\/script/gi, '<\\/script')}));
        </script></body></html>`;
    return withChromiumPage(html, async ({ args, url }) => {
        const result = spawnSync(process.env.CHROMIUM_BIN || 'chromium', [
            ...args, `--virtual-time-budget=${virtualTimeBudget}`, '--dump-dom', url,
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const output = result.stdout.match(/<script id="results" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
        assert.ok(output && output !== 'null', `Browser tests did not finish.\n${result.stderr}\n${result.stdout}`);
        const results = JSON.parse(output);
        assert.equal(results.length, count, 'All browser checks must report a result.');
        for (const result of results) await t.test(result.name, () => assert.equal(result.error, undefined, result.error));
    });
}

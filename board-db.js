/* ==========================================================================
 * board-db.js — shared local "database" layer for the PerfoTec Project Board
 * --------------------------------------------------------------------------
 * Binds a single local folder (chosen once by the user) via the File System
 * Access API and persists its directory handle in IndexedDB, so every hub tool
 * (board.html, business_case / intake / proposal / report, and the product
 * dashboard) can reach the same project files across page loads. Everything is
 * same-origin on http://localhost, which is a secure context — required for
 * both the File System Access API and for storing handles in IndexedDB.
 *
 * Folder layout inside the chosen root:
 *     board.json                          manifest (all projects + metadata)
 *     projects/<projectId>/<phase>.json   per-phase tool exports
 *     projects/<projectId>/pipedrive.json CRM snapshot (written by the sync)
 *     .sync/pipedrive-state.json          sync bookkeeping (see pipedrive-sync.mjs)
 *
 * Exposes window.PerfoTecBoard. No framework dependencies (plain ES5-ish JS so
 * it can be included via a normal <script> tag before the Babel/React module).
 * ========================================================================== */
(function () {
    'use strict';

    var DB_NAME = 'perfotec-board';
    var STORE = 'handles';
    var HANDLE_KEY = 'root';
    var MANIFEST_NAME = 'board.json';
    var PROJECTS_DIR = 'projects';
    var STATE_DIR = '.sync';
    var STATE_FILE = 'pipedrive-state.json';

    // Untouched snapshot of the Pipedrive deal, written by pipedrive-sync.mjs on
    // every run. Deliberately NOT a phase: it is an input to the workflow, not a
    // step in it, and no tool owns or edits it.
    var SEED_FILE = 'pipedrive.json';

    // Our own <script> URL. board.html sits next to this file, so every page can
    // resolve the board from here regardless of the URL it was itself opened on.
    // Every tool including the dashboard now lives in this one folder, so a plain
    // relative link would work too; resolving from the script URL is kept because
    // it does not care where the page sits, which is what let the dashboard move
    // into this folder without touching anything here.
    var _scriptUrl = (document.currentScript && document.currentScript.src) || '';

    // Workflow phases, in board order. `file` is the JSON filename written by
    // the tool that owns that phase; `tool` is the page that opens it.
    //
    // Business Case was removed in July 2026: a project is now created in
    // Pipedrive and reaches the board at Intake once the CRM gives a Go. See
    // PIPEDRIVE_INTEGRATION.md. `LEGACY_PHASE_MAP` below migrates cards that
    // still sit in the old phase — without it they would have no column to
    // render in and would look deleted.
    var PHASES = [
        { key: 'intake',       label: 'Intake',        file: 'intake.json',        tool: 'intake.html' },
        { key: 'proposal',     label: 'Proposal',      file: 'proposal.json',      tool: 'proposal.html' },
        // Proposal signed off by the client, but the trial has not started and
        // often has no start date yet. Deliberately shares report.json with the
        // Report phase and opens the same tool: a card here IS the report the
        // trial will produce, it just has not begun. Sharing the file is what
        // makes "clicking a tile shows exactly the Report phase" true without a
        // second document to keep in step.
        //
        // Safe against the drop handler's forward-copy: moving Accepted → Report
        // finds report.json already has content, so it takes the `else` branch and
        // only sets the flag — it never copies the file onto itself.
        { key: 'accepted',     label: 'Accepted',      file: 'report.json',        tool: 'report.html' },
        { key: 'report',       label: 'Report',        file: 'report.json',        tool: 'report.html' },
        { key: 'dashboard',    label: 'Dashboard',     file: 'dashboard.json',
          tool: 'dashboard.html' }
    ];
    var LEGACY_PHASE_MAP = { businessCase: 'intake' };
    var PHASE_BY_KEY = {};
    PHASES.forEach(function (p) { PHASE_BY_KEY[p.key] = p; });

    var _cachedRoot = null; // in-memory cache of the directory handle

    // ---- IndexedDB: persist the FileSystemDirectoryHandle -------------------
    function openIDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbGet(key) {
        return openIDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readonly');
                var req = tx.objectStore(STORE).get(key);
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbSet(key, val) {
        return openIDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(val, key);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    // ---- Permission helpers -------------------------------------------------
    function queryPermission(handle) {
        if (!handle || !handle.queryPermission) return Promise.resolve('granted');
        return handle.queryPermission({ mode: 'readwrite' });
    }
    function requestPermission(handle) {
        if (!handle || !handle.requestPermission) return Promise.resolve('granted');
        return handle.requestPermission({ mode: 'readwrite' });
    }

    // ---- Low-level directory/file helpers -----------------------------------
    function readJSONFromDir(dirHandle, filename) {
        return dirHandle.getFileHandle(filename).then(function (fh) {
            return fh.getFile();
        }).then(function (file) {
            return file.text();
        }).then(function (txt) {
            return txt ? JSON.parse(txt) : null;
        }).catch(function (err) {
            if (err && err.name === 'NotFoundError') return null;
            throw err;
        });
    }

    function writeJSONToDir(dirHandle, filename, obj) {
        return dirHandle.getFileHandle(filename, { create: true }).then(function (fh) {
            return fh.createWritable();
        }).then(function (writable) {
            return writable.write(JSON.stringify(obj, null, 2)).then(function () {
                return writable.close();
            });
        });
    }

    function getProjectDir(root, id, create) {
        return root.getDirectoryHandle(PROJECTS_DIR, { create: !!create }).then(function (dir) {
            return dir.getDirectoryHandle(id, { create: !!create });
        });
    }

    // ---- Root handle access -------------------------------------------------
    function getRootHandle() {
        if (_cachedRoot) return Promise.resolve(_cachedRoot);
        return idbGet(HANDLE_KEY).then(function (handle) {
            _cachedRoot = handle || null;
            return _cachedRoot;
        });
    }

    // Resolve the root handle and guarantee read/write permission is already
    // granted. Throws a tagged error the caller can react to (show a "choose
    // folder" or "grant access" button) instead of silently failing.
    function requireGrantedRoot() {
        return getRootHandle().then(function (root) {
            if (!root) { var e1 = new Error('No project folder selected'); e1.code = 'NO_FOLDER'; throw e1; }
            return queryPermission(root).then(function (state) {
                if (state !== 'granted') { var e2 = new Error('Folder permission required'); e2.code = 'NEEDS_PERMISSION'; throw e2; }
                return root;
            });
        });
    }

    // ---- Public API ---------------------------------------------------------

    function isSupported() {
        return typeof window !== 'undefined' && !!window.showDirectoryPicker && !!window.indexedDB;
    }

    // Everything cached in this module describes the folder that is currently
    // bound, so binding another folder has to drop all of it. Leaving it in place
    // is not cosmetic: `_metaCache` would report the previous folder's format (a
    // migrated folder followed by a legacy one renders as an empty board), and
    // `_lastRead` would make the next save diff against ANOTHER folder's cards —
    // every card missing from that stale snapshot resolves as "deleted" and gets
    // tombstoned.
    function resetFolderCaches() {
        _metaCache = null;
        _lastRead = null;
        // A read of the previous folder still in flight must not set the snapshot.
        _lastReadGen = ++_readGen;
        _lastArtefacts = [];
        _lastProductArtefacts = [];
        _lastRootArtefacts = [];
    }

    // Prompt the user to pick a folder (must run inside a user gesture) and
    // persist the handle. Returns { ok, name } or throws on abort.
    function pickRootFolder() {
        return window.showDirectoryPicker({ mode: 'readwrite', id: 'perfotec-projects' }).then(function (handle) {
            _cachedRoot = handle;
            resetFolderCaches();
            return idbSet(HANDLE_KEY, handle).then(function () {
                return { ok: true, name: handle.name };
            });
        });
    }

    // 'none' (no folder bound) | 'granted' | 'prompt' | 'denied'
    function permissionState() {
        return getRootHandle().then(function (root) {
            if (!root) return 'none';
            return queryPermission(root);
        });
    }

    // Re-grant access to the already-bound folder (must run inside a gesture).
    function requestAccess() {
        return getRootHandle().then(function (root) {
            if (!root) return false;
            return requestPermission(root).then(function (s) { return s === 'granted'; });
        });
    }

    function getRootName() {
        return getRootHandle().then(function (root) { return root ? root.name : null; });
    }

    // Rewrite phases that no longer have a column. Done in memory on every read
    // rather than as a one-off write, so the board renders correctly even before
    // anything is saved; the next persist() heals the file on disk.
    function migratePhases(manifest) {
        var changed = false;
        (manifest.projects || []).forEach(function (p) {
            var to = p && LEGACY_PHASE_MAP[p.phase];
            if (to) { p.phase = to; changed = true; }
        });
        if (changed) manifest.migratedPhases = true;
        return manifest;
    }

    // The pre-split store: one board.json holding every project. Kept for
    // backwards compatibility and as the source for migrateToCards().
    function readLegacyManifest() {
        return requireGrantedRoot().then(function (root) {
            return readJSONFromDir(root, MANIFEST_NAME).then(function (m) {
                if (m && Array.isArray(m.projects)) return migratePhases(m);
                return { schemaVersion: '1.0', isPerfoTecBoard: true, projects: [] };
            });
        });
    }

    // Read the CRM snapshot for a project (null when the project did not come
    // from Pipedrive, or the sync has not run yet).
    function readSeedFile(projectId) {
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, false).then(function (dir) {
                return readJSONFromDir(dir, SEED_FILE);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        });
    }

    // Sync bookkeeping written by pipedrive-sync.mjs: last run time and any
    // unresolved phase conflicts, so the board can surface them.
    function readSyncState() {
        return requireGrantedRoot().then(function (root) {
            return root.getDirectoryHandle(STATE_DIR, { create: false }).then(function (dir) {
                return readJSONFromDir(dir, STATE_FILE);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        });
    }

    // In-flight write counter. The "back to board" button waits for this to drain
    // so navigating away cannot cut off a save that is already on its way to disk.
    var _pendingWrites = 0;
    function trackWrite(p) {
        _pendingWrites++;
        var done = function () { _pendingWrites = Math.max(0, _pendingWrites - 1); };
        return p.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
    }

    function writeLegacyManifest(manifest) {
        return trackWrite(requireGrantedRoot().then(function (root) {
            return writeJSONToDir(root, MANIFEST_NAME, manifest);
        }));
    }

    function readPhaseFile(projectId, phaseKey) {
        var phase = PHASE_BY_KEY[phaseKey];
        if (!phase) return Promise.reject(new Error('Unknown phase: ' + phaseKey));
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, false).then(function (dir) {
                return readJSONFromDir(dir, phase.file);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null; // project dir absent yet
                throw err;
            });
        });
    }

    // Does a parsed export actually carry a project's data (vs. a blank stub that
    // a tool autosaved before its content loaded)? Used to skip empty files when
    // choosing which phase file to open.
    function hasContent(d) {
        if (!d || typeof d !== 'object') return false;
        var p = d.project || {};
        var ci = d.clientInfo || d.client || {};
        // Only the identifying fields count — NOT default packaging/specs, which a
        // blank stub also carries and would falsely read as "has content".
        if ((p.productName || '').trim() || (ci.companyName || '').trim()) return true;
        if (Array.isArray(d.products) && d.products.some(function (x) { return x && (x.name || '').trim(); })) return true;
        // Measured results or photos count too: a report holding measurements
        // but no product or company name read as empty, so the next open loaded
        // an older phase file instead and the autosave replaced the report.
        // (A stub's seeded P+0 row is not a result: see variantHasResults.)
        if ((d.groups || []).some(function (g) {
            return variantHasResults(g) || ((g && g.measurements) || []).some(function (m) { return m && Array.isArray(m.images) && m.images.length > 0; });
        })) return true;
        return false;
    }

    // A phase file that is an empty object holds nothing. The board's copy used
    // to write one to "drop" a document, and every tool then refused it as
    // unrecognised and kept its autosave off, so whatever was typed into the
    // copy was lost (October 2026). It counts as no file at all.
    function isEmptiedDoc(d) {
        return !!d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 0;
    }

    // ---- A report document without its results ------------------------------
    // A report is a mix: project, client and supply chain describe the set-up;
    // the measurements and the analysis are that trial's results. A copy keeps
    // the first and blanks the second: the variants, the evaluation days and the
    // sample slots stay (that is the plan), every measured value, photo, score,
    // note and conclusion goes.
    function stripTrialResults(doc) {
        var out = {};
        Object.keys(doc || {}).forEach(function (k) { out[k] = doc[k]; });
        delete out.analysis;      // conclusions, recommendations, next steps
        delete out.exportDate;    // belongs to the original's export
        out.groups = ((doc && doc.groups) || []).map(function (g) {
            var ng = {};
            Object.keys(g || {}).forEach(function (k) { ng[k] = g[k]; });
            delete ng.predictedImage;
            ng.measurements = ((g && g.measurements) || []).map(function (m) {
                return {
                    day: m.day,
                    samples: (m.samples || []).map(function (sm) { return { id: sm && sm.id, o2: '', co2: '', weight: '' }; }),
                    // qualityParams must stay an array: the report's pencil dialog
                    // maps over it, and {} blanked the page there.
                    quality: '', legacyQuality: '', notes: '', images: [], qualityParams: [],
                    evaluateQuality: Array.isArray(m.evaluate) ? m.evaluate.length > 0 : !!m.evaluateQuality,
                    measure: m.measure, open: m.open, evaluate: m.evaluate
                };
            });
            return ng;
        });
        return out;
    }

    // Does a report document still carry results — anything measured, scored,
    // photographed or concluded? The structure (variants, days, sample slots)
    // is not a result: a stripped copy keeps it on purpose.
    function trialResultsIn(doc) {
        if (!doc || typeof doc !== 'object') return false;
        var filled = function (v) { return v !== undefined && v !== null && String(v).trim() !== ''; };
        if (doc.analysis && typeof doc.analysis === 'object' && Object.keys(doc.analysis).length) return true;
        return (doc.groups || []).some(function (g) {
            return ((g && g.measurements) || []).some(function (m) {
                if (!m) return false;
                if (filled(m.quality) || filled(m.legacyQuality) || filled(m.originalQuality) || filled(m.notes)) return true;
                if (Array.isArray(m.images) && m.images.length) return true;
                if ((m.qualityParams || []).some(function (q) { return q && (filled(q.score) || filled(q.notes)); })) return true;
                return (m.samples || []).some(function (sm) {
                    return !!sm && (filled(sm.o2) || filled(sm.co2) || filled(sm.weight) || filled(sm.initialWeight));
                });
            });
        });
    }

    // ---- Quality of one measurement day --------------------------------------
    // One rule for every page that shows or passes on a day's quality: the
    // report (its table, charts, PDF and export) and the dashboard's trial
    // import. Two copies of it would drift, and then the dashboard would store
    // a different score than the report printed.
    //
    //   * the "score quality" checkbox switched off -> no quality, whatever is
    //     left in the fields. That is how a user says "not assessed today" —
    //     but only on a row a current tool has saved (it carries a
    //     `legacyQuality` key). Before, the box only opened the criteria
    //     panel: the per-row dropdown WAS the quality, whatever the box said,
    //     the trial-import skill writes `false` beside real scores, and an old
    //     loader wrote false for every missing flag. On such a row the flag
    //     means nothing; the report ticks it when it first loads the row.
    //   * criterion scores entered -> their mean, one decimal. A blank
    //     criterion does not count, nor does a number outside the 1-10 scale
    //     (firmness readings typed into "Texture / Firmness" were found in
    //     real data).
    //   * no criterion scores, but an older overall score -> that score.
    //   * otherwise -> no quality.
    //
    // Returns { value, legacy, count } or null. `legacy` marks an overall score
    // rather than an average, so the report can show it differently.
    function round1(n) { return Math.round(Number((n * 10).toPrecision(12))) / 10; }

    function scoreIn(v, min) {
        if (v === null || v === undefined || typeof v === 'object') return NaN;
        var s = String(v).trim().replace(',', '.');
        if (s === '') return NaN;
        var n = Number(s);
        return isFinite(n) && n >= min && n <= 10 ? n : NaN;
    }

    // The criterion scores of a row that count: filled in and on the 1-10 scale.
    function criterionScores(m) {
        var params = Array.isArray(m.qualityParams) ? m.qualityParams : [];
        var scores = [];
        params.forEach(function (q) {
            var n = scoreIn(q && q.score, 1);
            if (!isNaN(n)) scores.push(n);
        });
        return scores;
    }

    // The overall score a row carried before quality became the average of its
    // criteria: the former per-row dropdown, or the trial-import skill. Once a
    // tool has normalised the row it sits in `legacyQuality` (possibly '').
    // Before that it is `quality` — but only as a STRING: the dropdown and the
    // import both write strings, while a NUMBER there is a placeholder the code
    // seeded (9, or 10 on day 0) that nobody ever chose. A row that already has
    // criterion scores keeps no older score: the average replaces it, and
    // keeping it would bring the old dropdown value back the moment someone
    // cleared those scores.
    function measurementLegacyQuality(m) {
        if (!m || typeof m !== 'object') return '';
        if (m.legacyQuality !== undefined && m.legacyQuality !== null) return String(m.legacyQuality).trim();
        if (criterionScores(m).length) return '';
        return typeof m.quality === 'string' ? m.quality.trim() : '';
    }

    function measurementQuality(m) {
        if (!m || typeof m !== 'object') return null;
        var normalised = m.legacyQuality !== undefined && m.legacyQuality !== null;
        if (m.evaluateQuality === false && normalised) return null;
        var scores = criterionScores(m);
        if (scores.length) {
            var sum = scores.reduce(function (a, n) { return a + n; }, 0);
            return { value: round1(sum / scores.length), legacy: false, count: scores.length };
        }
        // The trial-import skill uses a 0-10 scale for its overall score.
        var legacy = scoreIn(measurementLegacyQuality(m), 0);
        if (!isNaN(legacy)) return { value: round1(legacy), legacy: true, count: 0 };
        return null;
    }

    /* ---- trials of a product ------------------------------------------------
     * What the Products page and the product dashboard list for one product:
     * every project linked to it (card.productId) that runs or ran through the
     * report tool — Accepted, Report or Dashboard, and archived ones (a card is
     * only archived from Dashboard). Stopped projects are left out, and so is
     * work still in intake or proposal.
     * ---------------------------------------------------------------------- */
    var TRIAL_PHASES = { accepted: true, report: true, dashboard: true };

    function isProductTrial(card, productId) {
        return !!card && !!productId && card.productId === productId && !card.deletedAt && !card.haltedAt
            && (!!card.archivedAt || TRIAL_PHASES[card.phase] === true);
    }

    // Finished = past the report (in Dashboard, or archived from there).
    function trialStatus(card) {
        return card && (card.archivedAt || card.phase === 'dashboard') ? 'completed' : 'ongoing';
    }

    // The facts the overview shows, from the trial's report document:
    //   target: 'achieved' | 'partial' | 'notAchieved' | null (not assessed);
    //   packagings: the packaging types used (project and variants);
    //   best: the highest score on the latest day all scored variants share
    //     (else each variant's last scored day), by the report's own rule
    //     (measurementQuality), with variant and day. Day 0 is ~10 for every
    //     variant, so it never counts as that common day.
    function summariseTrial(doc) {
        var d = doc || {};
        var p = d.project || {};
        var intakeProduct = d.isPerfoTecIntake && Array.isArray(d.products) ? (d.products[0] || {}) : null;
        var packagings = [];
        var addPack = function (v) { v = String(v == null ? '' : v).trim(); if (v && packagings.indexOf(v) < 0) packagings.push(v); };
        var pk = intakeProduct ? intakeProduct.packagings : p.packagings;
        (Array.isArray(pk) ? pk : []).forEach(function (x) { addPack(x && x.packagingType); });
        if (!packagings.length) addPack(p.packagingType);
        (d.groups || []).forEach(function (g) { addPack(g && g.specs && g.specs.packaging); });
        // Variants are compared on the same day: the latest day after P+0 on
        // which every scored variant has a score. Each variant's own last score
        // let one evaluated only at P+3 (9.0) beat one still good at P+14 (7.5).
        // Without such a common day, each variant's last score, as before.
        var scored = [];
        (d.groups || []).forEach(function (g) {
            var byDay = {}, last = null;
            ((g && g.measurements) || []).slice().sort(function (x, y) { return (parseFloat(x.day) || 0) - (parseFloat(y.day) || 0); }).forEach(function (m) {
                var q = measurementQuality(m);
                if (!q) return;
                var day = parseFloat(m.day) || 0;
                byDay[day] = q;
                last = { q: q, day: day };
            });
            if (last) scored.push({ g: g, byDay: byDay, last: last });
        });
        var commonDays = scored.length ? Object.keys(scored[0].byDay).map(Number).filter(function (day) {
            return day > 0 && scored.every(function (s) { return s.byDay[day] !== undefined; });
        }) : [];
        var onDay = commonDays.length && scored.length > 1 ? Math.max.apply(null, commonDays) : null;
        var best = null;
        scored.forEach(function (s) {
            var at = onDay !== null ? { q: s.byDay[onDay], day: onDay } : s.last;
            if (!best || at.q.value > best.value) best = { value: at.q.value, variant: (s.g && s.g.name) || '', day: at.day, legacy: at.q.legacy };
        });
        // The conditions it ran at. Temperature: the most frequent one among the
        // supply-chain stages (the rule the dashboard import uses), with the
        // lowest and highest when the chain had more than one. Pack weight in
        // grams: the project's, else the variants'. Duration: the last day measured.
        var tempCounts = {}, temps = [];
        (d.supplyChain || []).forEach(function (s) {
            var v = parseFloat(reportNums(s && s.tempStart)[0]);
            if (!isFinite(v)) return;
            if (!tempCounts[v]) temps.push(v);
            tempCounts[v] = (tempCounts[v] || 0) + 1;
        });
        var mainTemp = temps.length ? temps.slice().sort(function (x, y) { return tempCounts[y] - tempCounts[x]; })[0] : null;
        var weights = [];
        var addWeight = function (v) { var n = parseFloat(reportNums(v)[0]); if (isFinite(n) && n > 0 && weights.indexOf(n) < 0) weights.push(n); };
        addWeight(p.startWeight);
        if (!weights.length) (d.groups || []).forEach(function (g) { addWeight(g && g.specs && g.specs.startWeight); });
        weights.sort(function (x, y) { return x - y; });
        var lastDay = 0;
        (d.groups || []).forEach(function (g) { ((g && g.measurements) || []).forEach(function (m) { var day = parseFloat(m && m.day); if (isFinite(day) && day > lastDay) lastDay = day; }); });
        var a = d.analysis || {};
        var target = a.targetAchieved === 'achieved' || a.targetAchieved === 'partial' || a.targetAchieved === 'notAchieved' ? a.targetAchieved : null;
        return {
            isReport: !!d.isPerfoTecReport,
            title: projectTitle(p.reportTitle),
            packingDate: p.packingDate || '',
            target: target,
            packagings: packagings,
            best: best,
            temp: mainTemp,
            tempRange: temps.length > 1 ? [Math.min.apply(null, temps), Math.max.apply(null, temps)] : null,
            weights: weights,
            days: lastDay,
            variants: (d.groups || []).length
        };
    }

    // ---- Best practice from the trial table ----------------------------------
    // One rule for every "best" the dashboard shows (decided Oct 2026):
    //   * shelf life = the report's rule: the last evaluated day with a score of
    //     QUALITY_LIMIT (7) or more before the first day below it, open-ended
    //     ("≥") when it never fell below. A trial that ran to failure keeps its
    //     good days; it used to be dropped because its LAST score was low.
    //   * compared only within one variety, packaging type, condition
    //     (MAP/MHP/OPEN) and temperature band (2 °C);
    //   * ranked: longest shelf life, then open-ended over closed, then a curve
    //     over a bare end score, then the gain over the same round's reference,
    //     then the score on that day, then the most recent round. Never the
    //     order of the table;
    //   * "proven" needs at least 2 rounds that reached the winner's shelf life,
    //     otherwise it is indicative (1 round).
    // References (controls) count like any variant: a standard film perforated
    // well is a PerfoTec result too. Their role is shown and used for the gain.
    var QUALITY_LIMIT = 7;
    var REFERENCE_NAME = /\b(control|controle|testigo|reference|referentie|referencia|standard|standaard|current|huidige?|actual)\b/i;

    // "day:score|day:score" → [{ d, q }] sorted by day.
    function parseTrialCurve(raw) {
        return String(raw == null ? '' : raw).split('|').map(function (s) {
            var p = s.split(':');
            return { d: parseFloat(p[0]), q: parseFloat(String(p[1] == null ? '' : p[1]).replace(',', '.')) };
        }).filter(function (p) { return isFinite(p.d) && isFinite(p.q); }).sort(function (a, b) { return a.d - b.d; });
    }
    // { days, open, score } by the report's rule, or null when the curve says
    // nothing after P+0 (only day 0 scored, or already below the limit then).
    // A result that fell below the limit during the trial also carries the first
    // measurement below it: belowDay, belowScore.
    function curveShelfLife(points, limit) {
        var lim = limit == null ? QUALITY_LIMIT : limit;
        var ok = null;
        for (var i = 0; i < points.length; i++) {
            if (points[i].q >= lim) ok = points[i];
            else return ok && ok.d > 0 ? { days: ok.d, open: false, score: ok.q, belowDay: points[i].d, belowScore: points[i].q } : null;
        }
        return ok && ok.d > 0 ? { days: ok.d, open: true, score: ok.q } : null;
    }
    // 'reference' | 'perfotec': the stored role (from the report tool), else
    // read from the variant name ("Control", "testigo", "standard", ...).
    function trialRowRole(master, i) {
        var m = master || {};
        var r = String(m['pack_opt_' + i + '_role'] || '').toLowerCase();
        if (r === 'reference' || r === 'perfotec') return r;
        return REFERENCE_NAME.test(String(m['pack_opt_' + i + '_material'] || '')) ? 'reference' : 'perfotec';
    }
    function firstNumber(v) { var n = reportNums(v); return n.length ? parseFloat(n[0]) : NaN; }
    // The trial rows of a table as objects with their shelf life. opts.type
    // limits to one packaging type ('Crate/Box' also takes 'Liner'), opts.match
    // (i) => bool filters rows (e.g. the variety view filter).
    function trialRows(master, opts) {
        var m = master || {};
        var o = opts || {};
        var n = trialRowCount(m);
        var rows = [], seen = {};
        for (var i = 0; i < n; i++) {
            var f = function (k) { var v = m['pack_opt_' + i + '_' + k]; return v == null ? '' : String(v).trim(); };
            var type = f('type');
            if (!['type', 'material', 'o2', 'co2', 'days', 'rating', 'curve'].some(function (k) { return f(k) !== ''; })) continue;
            if (o.type && !(type === o.type || (o.type === 'Crate/Box' && /^(liner|crate\/box)$/i.test(type)))) continue;
            if (o.match && !o.match(i)) continue;
            var curve = parseTrialCurve(f('curve'));
            var rating = firstNumber(f('rating')), days = firstNumber(f('days'));
            var sl = curve.length >= 2 ? curveShelfLife(curve) : null;
            var legacy = false;
            if (!sl && curve.length < 2 && rating >= QUALITY_LIMIT && days > 0) { sl = { days: days, open: true, score: rating }; legacy = true; }
            // One report is one round, whichever way its rows came in: the
            // board's rows carry the project, the dashboard's file import does
            // not, and keyed on the project one report counted as two rounds
            // ("proven" from a single trial).
            var roundNo = parseInt(f('round'), 10);
            var reportKey = (f('pdf') || f('date')) ? f('pdf').toLowerCase() + '|' + f('date') : f('project');
            var round = reportKey + (roundNo > 1 ? '#R' + roundNo : '');
            // The same trial twice (the averaged variety view concatenates
            // tables) is one trial.
            var fp = [type, f('material'), round, f('days'), f('rating'), f('curve')].join('|').toLowerCase();
            if (seen[fp]) continue;
            seen[fp] = true;
            var temp = firstNumber(f('temp'));
            rows.push({
                i: i, type: type, material: f('material'), variety: f('variety'),
                condition: (f('condition') || 'MAP').toUpperCase(),
                temp: isFinite(temp) ? temp : null, tempBand: isFinite(temp) ? Math.round(temp / 2) * 2 : null,
                weight: f('weight'), o2: f('o2'), co2: f('co2'), trans: f('trans'),
                film: f('film'), filmSpec: f('filmSpec'),
                // How it was packed (Luke 2026-11-11): the perforation ('perfotec' |
                // 'other' | 'none'), the gas flush ('o2control' | 'other' | 'none')
                // and the O2 / CO2 in the pack at packing; '' = not recorded.
                perf: f('perf'), flush: f('flush'), startO2: f('startO2'), startCO2: f('startCO2'),
                // Links into the Hub catalogue (ids): the package and the laser program.
                hubPackage: f('hubPackage'), laserProgram: f('laserProgram'),
                date: f('date'), pdf: f('pdf'), project: f('project'), round: round, role: trialRowRole(m, i),
                rating: isFinite(rating) ? rating : null, days: isFinite(days) ? days : null,
                curve: curve, shelfLife: sl, legacy: legacy, gain: null
            });
        }
        // Gain over the reference of the same round (days of shelf life).
        var refDays = {};
        rows.forEach(function (r) {
            if (r.role !== 'reference') return;
            var d = r.shelfLife ? r.shelfLife.days : 0;
            refDays[r.round] = refDays[r.round] == null ? d : Math.max(refDays[r.round], d);
        });
        rows.forEach(function (r) { if (r.shelfLife && refDays[r.round] != null) r.gain = r.shelfLife.days - refDays[r.round]; });
        return rows;
    }
    function compareTrials(a, b) {
        var sa = a.shelfLife, sb = b.shelfLife;
        if (!!sa !== !!sb) return sa ? -1 : 1;
        if (!sa) return a.i - b.i;
        if (sa.days !== sb.days) return sb.days - sa.days;
        if (sa.open !== sb.open) return sa.open ? -1 : 1;
        if (a.legacy !== b.legacy) return a.legacy ? 1 : -1;
        var ga = a.gain == null ? -Infinity : a.gain, gb = b.gain == null ? -Infinity : b.gain;
        if (ga !== gb) return gb - ga;
        if (sa.score !== sb.score) return sb.score - sa.score;
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.i - b.i;
    }
    // Pack sizes: fixed weight classes that widen with the weight (Luke
    // 2026-11-02), the same for every product so like packs compare across the
    // range: < 75 g, 75–150, 150–250, 250–400, 400–750, 750–1400 g, 1.4–2 kg,
    // 2–3, 3–5, 5–7.5, 7.5–12.5 kg, and on in the 2–3–5–7.5–12.5 rhythm (20–30 kg,
    // …, pallets in the hundreds of kilos). A class includes its lower bound.
    // { index, minKg, maxKg } (maxKg excluded), or null without a weight.
    var PACK_SIZE_BOUNDS_G = [75, 150, 250, 400, 750, 1400, 2000, 3000, 5000, 7500, 12500];
    function packSizeBand(kg) {
        if (!isFinite(kg) || kg <= 0) return null;
        var g = kg * 1000, lo = 0, i = 0, hi;
        var bound = function (k) {
            if (k < PACK_SIZE_BOUNDS_G.length) return PACK_SIZE_BOUNDS_G[k];
            // Past 12.5 kg: 20, 30, 50, 75, 125 kg, then ×10 again.
            var cycle = [2000, 3000, 5000, 7500, 12500], j = k - PACK_SIZE_BOUNDS_G.length;
            return cycle[j % 5] * Math.pow(10, Math.floor(j / 5) + 1);
        };
        while (g >= (hi = bound(i))) { lo = hi; i++; }
        return { index: i, minKg: lo / 1000, maxKg: hi / 1000 };
    }
    // Temperature groups of 5 °C (Luke 2026-11-02): 0 °C is everything below 2.5,
    // 5 °C 2.5 up to 7.5, 10 °C 7.5 up to 12.5, and so on. The group is how a
    // result is filed; the temperature shown is the one the trial ran at.
    // How a pack was perforated and flushed, as the trial rows store it.
    var PACK_PERF = { perfotec: 'PerfoTec laser perforation', other: 'Other perforation', none: 'No perforation' };
    var PACK_FLUSH = { o2control: 'Gas flush with O2 Control', other: 'Gas flush, other system', none: 'No gas flush' };
    var TEMP_GROUP_STEP = 5;
    function tempGroupOf(t, step) {
        var s = step > 0 ? step : TEMP_GROUP_STEP;
        return t == null || !isFinite(t) ? null : Math.max(0, Math.round(t / s) * s);
    }
    // { groups: [...], best } for one table. Each group is one packaging type +
    // variety + condition + temperature group + pack size with its winner, the
    // rounds that reached the winner's shelf life and whether that makes it
    // proven. A 500 g pack at 20 °C is not compared with a 200 g one: the TV that
    // works scales with the mass in the pack (Luke 2026-11-02 — per weight).
    // Groups are ordered: proven first, then by their winner. `best` is the
    // first group with a winner, or null. group.tempBand: the temperature group
    // (opts.tempGroup: another width in °C); group.size: { minKg, maxKg } or
    // null (no weight logged).
    function trialBestPractice(master, opts) {
        var rows = trialRows(master, opts);
        var step = opts && opts.tempGroup;
        var byKey = {};
        var typeOf = function (r) { return /^liner$/i.test(r.type) ? 'Crate/Box' : r.type; };
        rows.forEach(function (r) {
            // A punnet round and a pallet round are not two rounds of one practice.
            var type = typeOf(r);
            r.weightKg = rowWeightKg(r.type, r.weight);
            var size = packSizeBand(r.weightKg);
            var tg = tempGroupOf(r.temp, step);
            // The variety is NOT part of the comparison (Luke 2026-11-16): a second
            // round with another cultivar, or with none recorded, verifies the
            // result just as well. It stays on each trial, and group.variety is the
            // winner's. A view of one variety filters the rows first (opts.match).
            var key = [type.toLowerCase(), r.condition, tg == null ? '?' : tg, size ? 's' + size.index : '?'].join('|');
            (byKey[key] = byKey[key] || { key: key, type: type, variety: '', condition: r.condition, tempBand: tg, size: size, trials: [] }).trials.push(r);
        });
        var groups = Object.keys(byKey).map(function (k) {
            var g = byKey[k];
            g.trials.sort(compareTrials);
            var w = g.trials[0] && g.trials[0].shelfLife ? g.trials[0] : null;
            g.winner = w;
            g.variety = w ? w.variety : (g.trials[0] ? g.trials[0].variety : '');
            g.varieties = g.trials.map(function (t) { return t.variety; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
            var rounds = {};
            if (w) g.trials.forEach(function (t) { if (t.shelfLife && t.shelfLife.days >= w.shelfLife.days) rounds[t.round] = true; });
            g.rounds = Object.keys(rounds).length;
            g.proven = !!w && g.rounds >= 2;
            var temps = g.trials.map(function (t) { return t.temp; }).filter(function (t) { return t != null; });
            g.tempMin = temps.length ? Math.min.apply(null, temps) : null;
            g.tempMax = temps.length ? Math.max.apply(null, temps) : null;
            return g;
        }).sort(function (a, b) {
            if (!!a.winner !== !!b.winner) return a.winner ? -1 : 1;
            if (a.proven !== b.proven) return a.proven ? -1 : 1;
            if (a.winner && b.winner) return compareTrials(a.winner, b.winner);
            return b.trials.length - a.trials.length;
        });
        return { groups: groups, best: groups[0] && groups[0].winner ? groups[0] : null, rows: rows };
    }

    // ---- Configurations: one PerfoTec setting across all its rounds -----------
    // The best practice above answers "what is the longest shelf life within
    // specification anything reached", and it may reach it in a single round. A
    // claim to a client needs another question answered: "how does this setting
    // do every time it was tried, against the packaging the client uses now".
    //
    // A configuration is one PerfoTec variant (its material name) in one packaging
    // type, condition and temperature band. Its record compares it round by round
    // with the best reference of the same round and packaging type — the client's
    // current packaging (decided 2026-10-28). Varieties are counted, not split: a
    // claim is made for the product and states over how many cultivars it holds.
    //
    // Ranking, most consistent first: rounds better minus rounds worse than the
    // current packaging, then the number of rounds compared, then the median
    // shelf life. A setting that won one lucky round does not outrank one that won
    // five of sixteen and lost one.
    function normPackType(t) {
        return /^liner$/i.test(String(t || '')) ? 'Crate/Box' : String(t || '');
    }
    function configKeyOf(material) {
        return String(material == null ? '' : material).toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function medianOf(values) {
        var s = (values || []).filter(function (v) { return isFinite(v); }).sort(function (a, b) { return a - b; });
        if (!s.length) return null;
        var m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    function rangeOf(values) {
        var v = (values || []).filter(function (x) { return isFinite(x); });
        return v.length ? { min: Math.min.apply(null, v), max: Math.max.apply(null, v) } : null;
    }
    // The achieved atmosphere of a configuration: the middle half of its trials
    // (25th–75th percentile) and the median. This, not the target in a variant's
    // name ("10% O2 target"), is what the result came from (Luke 2026-10-28) —
    // and a full min–max range lets one odd pack speak for all of them.
    function typicalOf(values) {
        var s = (values || []).filter(function (x) { return isFinite(x); }).sort(function (a, b) { return a - b; });
        if (!s.length) return null;
        var q = function (p) { var k = p * (s.length - 1), lo = Math.floor(k), hi = Math.ceil(k); return s[lo] + (s[hi] - s[lo]) * (k - lo); };
        var r1 = function (x) { return Math.round(x * 10) / 10; };
        return { low: r1(q(0.25)), mid: r1(q(0.5)), high: r1(q(0.75)), n: s.length };
    }
    // A film transmits on its own before a single hole is lasered, so a TV below
    // this is not a TV. The archive imports filled the TV with the number of
    // perforations ("10 holes of 92 µm") where the real value was 1600; those
    // values stay in the table but never feed a curve, a recipe or a card.
    var MIN_PLAUSIBLE_TV = 100;
    function plausibleTv(v) {
        var n = firstNumber(v);
        return isFinite(n) && n >= MIN_PLAUSIBLE_TV ? n : null;
    }
    // Pack weights are stored in grams, a pallet's in kilograms.
    function rowWeightKg(type, weight) {
        var w = firstNumber(weight);
        if (!isFinite(w) || w <= 0) return null;
        return /^pallet$/i.test(String(type || '')) ? w : w / 1000;
    }
    // One result per round: the best of the rows given (two packs of the same
    // setting in one report are still one round).
    function bestPerRound(rows) {
        var byRound = {};
        rows.forEach(function (r) {
            var d = r.shelfLife ? r.shelfLife.days : 0;
            var open = !!(r.shelfLife && r.shelfLife.open);
            var p = byRound[r.round];
            if (!p || d > p.days || (d === p.days && open && !p.open)) byRound[r.round] = { round: r.round, days: d, open: open, row: r };
        });
        return byRound;
    }
    function compareConfigs(a, b) {
        var na = a.better - a.worse, nb = b.better - b.worse;
        if (na !== nb) return nb - na;
        if (a.compared !== b.compared) return b.compared - a.compared;
        var ma = a.medianDays == null ? -1 : a.medianDays, mb = b.medianDays == null ? -1 : b.medianDays;
        if (ma !== mb) return mb - ma;
        if (a.worse !== b.worse) return a.worse - b.worse;
        if (a.roundCount !== b.roundCount) return b.roundCount - a.roundCount;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    }
    // { configs: [...], best, rows } — opts as for trialRows (type, match).
    function trialConfigurations(master, opts) {
        var rows = trialRows(master, opts);
        var refByRoundType = {};
        var refs = {};
        rows.forEach(function (r) {
            if (r.role !== 'reference') return;
            var k = normPackType(r.type);
            (refs[k] = refs[k] || []).push(r);
        });
        Object.keys(refs).forEach(function (type) {
            var best = bestPerRound(refs[type]);
            Object.keys(best).forEach(function (round) { refByRoundType[round + '|' + type] = best[round]; });
        });
        var byKey = {};
        rows.forEach(function (r) {
            if (r.role === 'reference') return;
            var type = normPackType(r.type);
            var key = [type.toLowerCase(), r.condition, r.tempBand == null ? '?' : r.tempBand, configKeyOf(r.material)].join('|');
            (byKey[key] = byKey[key] || { key: key, type: type, condition: r.condition, tempBand: r.tempBand, material: r.material, trials: [] }).trials.push(r);
        });
        var configs = Object.keys(byKey).map(function (k) {
            var c = byKey[k];
            var perRound = bestPerRound(c.trials);
            var rounds = Object.keys(perRound).map(function (round) { return perRound[round]; });
            var better = 0, equal = 0, worse = 0, censoredTies = 0, compared = [];
            rounds.forEach(function (p) {
                var ref = refByRoundType[p.round + '|' + c.type];
                if (!ref) return;
                p.ref = ref;
                compared.push(p);
                if (p.days > ref.days) better++;
                else if (p.days < ref.days) worse++;
                else { equal++; if (p.open && ref.open) censoredTies++; }
            });
            var varieties = {};
            c.trials.forEach(function (t) { varieties[String(t.variety || '').toLowerCase()] = String(t.variety || ''); });
            var nums = function (field) { return c.trials.map(function (t) { return firstNumber(t[field]); }); };
            c.rounds = rounds;
            c.roundCount = rounds.length;
            c.compared = compared.length;
            c.better = better; c.equal = equal; c.worse = worse; c.censoredTies = censoredTies;
            c.medianDays = medianOf(rounds.map(function (p) { return p.days; }));
            c.referenceMedianDays = medianOf(compared.map(function (p) { return p.ref.days; }));
            c.openRounds = rounds.filter(function (p) { return p.open; }).length;
            c.varieties = Object.keys(varieties).filter(function (v) { return v !== ''; }).map(function (v) { return varieties[v]; }).sort();
            c.unknownVariety = Object.prototype.hasOwnProperty.call(varieties, '');
            // The register films its trials were packed in (ids, most used first).
            var filmUse = {};
            c.trials.forEach(function (t) { if (t.film) filmUse[t.film] = (filmUse[t.film] || 0) + 1; });
            c.films = Object.keys(filmUse).sort(function (a, b) { return filmUse[b] - filmUse[a] || (a < b ? -1 : 1); });
            c.temp = rangeOf(c.trials.map(function (t) { return t.temp == null ? NaN : t.temp; }));
            c.o2 = rangeOf(nums('o2'));
            c.co2 = rangeOf(nums('co2'));
            c.o2Typical = typicalOf(nums('o2'));
            c.co2Typical = typicalOf(nums('co2'));
            c.implausibleTv = c.trials.filter(function (t) { return String(t.trans || '').trim() !== '' && plausibleTv(t.trans) == null; }).length;
            c.horizons = rangeOf(c.trials.map(function (t) { return t.curve.length ? t.curve[t.curve.length - 1].d : NaN; }));
            return c;
        });
        configs.sort(compareConfigs);
        return { configs: configs, best: configs[0] || null, rows: rows };
    }

    // ---- Transmission ---------------------------------------------------------
    // The advised TV follows the product's respiration (decided 2026-10-29). A pack
    // has to let in as much oxygen as the product consumes, and consumption rises
    // with temperature (the predictive respiration curve) and with the mass in
    // the pack. So the model is
    //
    //     TV(T, W) = k · e^(b·T) · W
    //
    // b is the slope of the respiration curve (ln RR against °C, i.e. its Q10);
    // k is calibrated on the trials of the most consistent configuration that
    // carry a real TV — what was actually packed. With b > 0 and W > 0, a warmer
    // chain or a heavier pack ALWAYS gets a higher TV.
    //
    // It replaces a regression of TV against temperature on the trials alone:
    // trials cluster at one temperature, and from 18 and 19 °C that regression
    // read a Q10 of 0.002 — TV falling as it gets warmer.
    //
    // Few data: the respiration curve still gives the temperature behaviour, so
    // one real TV is enough for an advice at any temperature (marked as an
    // estimate away from the tested ones). No respiration curve: the product
    // sheet's Q10. Neither: a typical Q10 of 2 — said so, never silently.
    var DEFAULT_Q10 = 2;
    function boundedQ10(q) { return Math.max(1.3, Math.min(5, q)); }
    // Every trial with a temperature, a pack weight and a real TV, as TV per kg.
    function transmissionPoints(master, opts) {
        var o = opts || {};
        var m = master || {};
        var n = trialRowCount(m);
        var pts = [];
        for (var i = 0; i < n; i++) {
            if (o.match && !o.match(i)) continue;
            var f = (function (idx) { return function (k) { var v = m['pack_opt_' + idx + '_' + k]; return v == null ? '' : String(v).trim(); }; })(i);
            var type = f('type');
            if (o.type && normPackType(type) !== normPackType(o.type)) continue;
            var t = firstNumber(f('temp')), tv = plausibleTv(f('trans')), kg = rowWeightKg(type, f('weight'));
            if (!isFinite(t) || !kg || tv == null) continue;
            pts.push({ i: i, t: t, tvPerKg: tv / kg, tv: tv, kg: kg, type: type, condition: (f('condition') || 'MAP').toUpperCase(), role: trialRowRole(m, i) });
        }
        return pts;
    }
    // { b, q10, source, k, kMin, kMax, config, calibration, reason }
    //   source: 'respiration' | 'sheet' | 'default'
    //   reason (no k): 'no-trials' | 'no-real-tv'
    // opts: respSlope (respiration curve slope per °C), q10 (product sheet),
    //       match, type.
    function calibrateTransmission(master, opts) {
        var o = opts || {};
        var rs = parseFloat(o.respSlope), sq = parseFloat(o.q10);
        var q10, source;
        if (isFinite(rs) && rs > 0) { q10 = boundedQ10(Math.exp(10 * rs)); source = 'respiration'; }
        else if (isFinite(sq) && sq > 1) { q10 = boundedQ10(sq); source = 'sheet'; }
        else { q10 = DEFAULT_Q10; source = 'default'; }
        var b = Math.log(q10) / 10;
        var out = { b: b, q10: q10, source: source, k: null, kMin: null, kMax: null, config: null, calibration: [], reason: '' };
        var conf = trialConfigurations(master || {}, { match: o.match, type: o.type });
        if (!conf.configs.length) { out.reason = 'no-trials'; return out; }
        for (var c = 0; c < conf.configs.length; c++) {
            var cfg = conf.configs[c];
            var cal = cfg.trials.map(function (t) {
                var tv = plausibleTv(t.trans), w = rowWeightKg(cfg.type, t.weight);
                return (tv != null && w && t.temp != null) ? { i: t.i, t: t.temp, perKg: tv / w, k: (tv / w) / Math.exp(b * t.temp) } : null;
            }).filter(Boolean);
            if (!cal.length) continue;
            var ks = cal.map(function (p) { return p.k; });
            out.k = medianOf(ks);
            out.kMin = Math.min.apply(null, ks);
            out.kMax = Math.max.apply(null, ks);
            out.config = cfg;
            out.calibration = cal;
            return out;
        }
        out.reason = 'no-real-tv';
        return out;
    }

    // ---- The film: how deep a pack can take the oxygen ------------------------
    // The level k above is what one configuration packed. Another film needs
    // another TV (Luke 2026-10-29): a BOPE lets CO₂ out far better than a BOPP,
    // so a BOPE pack can go much deeper in O₂ before the CO₂ does damage, while
    // the BOPP control has to stay high.
    //
    // At steady state the product's uptake equals what the pack lets through:
    //     RR·W = TV·ΔO₂          (ΔO₂ = 20.9 − O₂ in the pack)
    //     RQ·RR·W = β·TV·CO₂     (β = the pack's CO₂ : O₂ transmission)
    // so the atmosphere a pack reached gives its β = RQ·ΔO₂ / CO₂, and a pack
    // that should keep the CO₂ the reference proved safe can take ΔO₂ = CO₂·β/RQ.
    // The TV scales with 1/ΔO₂: TV_film = TV_reference · ΔO₂_ref / ΔO₂_film.
    // Laser holes carry the gases at β ≈ 0.8; the film body of a PE carries CO₂
    // several times faster than O₂, which is the whole difference.
    //
    // β of a film, best source first: the atmosphere of its own trials (a TV is
    // not needed for that), then trials of films of the same polymer, then its
    // TDS (CO₂TR / OTR of the unperforated film — an upper bound, the holes pull
    // a pack's β down; reported as such). The O₂ never goes below the product's
    // floor and the CO₂ never above its tolerance, unless the trials already
    // proved a deeper or higher value safe.
    var AIR_O2 = 20.9;
    // β from a set of trial rows: the middle of their reached atmosphere.
    function packRatioOfRows(rows, rq) {
        var q = rq > 0 ? rq : 1;
        var use = (rows || []).filter(function (r) {
            var a = firstNumber(r.o2), c = firstNumber(r.co2);
            return String(r.condition || 'MAP').toUpperCase() === 'MAP' && isFinite(a) && isFinite(c) && c >= 0.5 && a >= 0 && a <= AIR_O2 - 0.5;
        });
        if (!use.length) return null;
        var o2 = typicalOf(use.map(function (r) { return firstNumber(r.o2); }));
        var co2 = typicalOf(use.map(function (r) { return firstNumber(r.co2); }));
        return { beta: q * (AIR_O2 - o2.mid) / co2.mid, n: use.length, o2: o2, co2: co2 };
    }
    // The film body's own CO₂ : O₂ ratio from its TDS, or null.
    function filmTdsRatio(film) {
        var otr = firstNumber(film && film.otr), co2tr = firstNumber(film && film.co2tr);
        return isFinite(otr) && isFinite(co2tr) && otr > 0 && co2tr > 0 ? co2tr / otr : null;
    }
    // { beta, source: 'film' | 'polymer' | 'tds', n, from } or null.
    function filmPackRatio(master, film, opts) {
        var o = opts || {};
        var rows = trialRows(master, { match: o.match, type: o.type });
        var own = packRatioOfRows(rows.filter(function (r) { return r.film === film.id; }), o.rq);
        if (own) return { beta: own.beta, source: 'film', n: own.n, from: [film.name] };
        var poly = String(film.polymer || '').trim().toLowerCase();
        if (poly && poly !== 'other') {
            var kin = (o.films || []).filter(function (f) { return f && f.id !== film.id && String(f.polymer || '').trim().toLowerCase() === poly; });
            var ids = kin.map(function (f) { return f.id; });
            var same = packRatioOfRows(rows.filter(function (r) { return ids.indexOf(r.film) >= 0; }), o.rq);
            if (same) {
                var used = kin.filter(function (f) { return rows.some(function (r) { return r.film === f.id; }); }).map(function (f) { return f.name; });
                return { beta: same.beta, source: 'polymer', n: same.n, from: used };
            }
        }
        var tds = filmTdsRatio(film);
        return tds != null ? { beta: tds, source: 'tds', n: 0, from: [film.name] } : null;
    }
    function filmScale(dRef, co2Ref, beta, o, rq, dMax, ceiling) {
        var target = parseFloat(o.targetO2);
        var d = isFinite(target) ? AIR_O2 - target : co2Ref * beta / rq;
        var capped = '';
        if (d > dMax) { d = dMax; capped = 'o2-floor'; }
        if (rq * d / beta > ceiling + 1e-9) { d = ceiling * beta / rq; capped = 'co2-ceiling'; }
        if (d < 0.3) d = 0.3;
        return { factor: dRef / d, o2: Math.round((AIR_O2 - d) * 10) / 10, co2: Math.round((rq * d / beta) * 10) / 10, capped: capped };
    }
    // How the calibrated level changes for opts.film (and/or opts.targetO2).
    function filmAdjustment(master, cur, o, film, calibratedOnFilm) {
        var rq = parseFloat(o.rq) > 0 ? parseFloat(o.rq) : 1;
        var cfg = cur.config;
        var o2R = cfg.o2Typical && cfg.o2Typical.mid, co2R = cfg.co2Typical && cfg.co2Typical.mid;
        if (!isFinite(o2R) || !isFinite(co2R) || co2R < 0.5 || o2R > AIR_O2 - 0.5) return { factor: null, reason: 'no-atmosphere' };
        var dR = AIR_O2 - o2R;
        var betaR = rq * dR / co2R;
        var ratio = (!film || calibratedOnFilm)
            ? { beta: betaR, source: film ? 'film' : 'reference', n: cfg.trials.length, from: film ? [film.name] : [] }
            : filmPackRatio(master, film, o);
        if (!ratio) return { factor: null, reason: 'no-ratio', betaR: betaR };
        var floor = parseFloat(o.o2Floor);
        var dMax = Math.max(AIR_O2 - (isFinite(floor) ? floor : 2), dR);
        var crit = parseFloat(o.co2Max);
        var ceiling = Math.max(isFinite(crit) ? crit : 0, co2R);
        var s = filmScale(dR, co2R, ratio.beta, o, rq, dMax, ceiling);
        var out = {
            factor: s.factor, beta: ratio.beta, betaSource: ratio.source, betaN: ratio.n, betaFrom: ratio.from, betaR: betaR, rq: rq,
            o2: s.o2, co2: s.co2, capped: s.capped, reference: { o2: o2R, co2: co2R },
            floor: AIR_O2 - dMax, ceiling: ceiling, altFactor: null
        };
        // A TDS ratio is the film body alone: the pack lies between it and a
        // pack that behaves like the reference's.
        if (ratio.source === 'tds') out.altFactor = filmScale(dR, co2R, betaR, o, rq, dMax, ceiling).factor;
        return out;
    }
    // The curve the advisor reads: calibrated as above, and — for a film from the
    // register (opts.film, opts.films) or an O₂ the user aims at (opts.targetO2) —
    // moved to that film's atmosphere. A film with real TVs of its own is
    // calibrated on those. opts also: rq, o2Floor, co2Max.
    //   calibratedOn: 'film' | 'all';  adjust: filmAdjustment's result;
    //   base: the level before the move.
    function transmissionCurve(master, opts) {
        var o = opts || {};
        var film = o.film && o.film.id ? o.film : null;
        var own = null;
        if (film) {
            var outer = o.match;
            var m = master || {};
            // The film's own rows, and the current packaging it was compared with:
            // without those the configuration has no record to rank on.
            var mine = function (i) { return (!outer || outer(i)) && (String(m['pack_opt_' + i + '_film'] || '').trim() === film.id || trialRowRole(m, i) === 'reference'); };
            var oo = {};
            Object.keys(o).forEach(function (k) { oo[k] = o[k]; });
            oo.match = mine;
            own = calibrateTransmission(master, oo);
            if (own.k == null) own = null;
        }
        var cur = own || calibrateTransmission(master, o);
        cur.calibratedOn = own ? 'film' : 'all';
        cur.adjust = null;
        cur.base = null;
        if (cur.k == null || (!film && !isFinite(parseFloat(o.targetO2)))) return cur;
        var adj = filmAdjustment(master, cur, o, film, !!own);
        cur.adjust = adj;
        if (adj.factor != null) {
            cur.base = { k: cur.k, kMin: cur.kMin, kMax: cur.kMax };
            cur.k = cur.base.k * adj.factor;
            cur.kMin = cur.base.kMin * (adj.altFactor != null ? Math.min(adj.factor, adj.altFactor) : adj.factor);
            cur.kMax = cur.base.kMax * (adj.altFactor != null ? Math.max(adj.factor, adj.altFactor) : adj.factor);
        }
        return cur;
    }
    // TV per kg the curve gives at temp (null without a calibration).
    function transmissionPerKgAt(curve, temp) {
        return curve && curve.k != null ? curve.k * Math.exp(curve.b * temp) : null;
    }
    // The TV to use for a pack of opts.weightKg at opts.temp.
    function transmissionAdvice(master, opts) {
        var o = opts || {};
        var temp = parseFloat(o.temp), kg = parseFloat(o.weightKg);
        var curve = transmissionCurve(master, o);
        var out = { recipe: null, curve: curve, reason: '' };
        if (!isFinite(temp) || !isFinite(kg) || kg <= 0) { out.reason = 'no-input'; return out; }
        if (curve.k == null) { out.reason = curve.reason; return out; }
        var f = Math.exp(curve.b * temp) * kg;
        var temps = curve.calibration.map(function (p) { return p.t; });
        var nearest = Math.min.apply(null, temps.map(function (t) { return Math.abs(t - temp); }));
        var cfg = curve.config;
        out.recipe = {
            tv: Math.round(curve.k * f), min: Math.round(curve.kMin * f), max: Math.round(curve.kMax * f),
            n: curve.calibration.length, material: cfg.material, type: cfg.type, condition: cfg.condition,
            o2: cfg.o2Typical, co2: cfg.co2Typical, temps: rangeOf(temps),
            extrapolated: nearest > 2, q10: curve.q10, source: curve.source,
            record: { better: cfg.better, equal: cfg.equal, worse: cfg.worse, compared: cfg.compared },
            // The film the advice is for, and how it got there (see filmAdjustment).
            film: o.film && o.film.id ? { id: o.film.id, name: o.film.name } : null,
            calibratedOn: curve.calibratedOn, configFilms: cfg.films || [],
            adjust: curve.adjust,
            referenceTv: curve.base ? Math.round(curve.base.k * f) : null
        };
        return out;
    }

    // ---- Data checks: proposals a person confirms -----------------------------
    // Two gaps that quietly bent every comparison above: the variety column was
    // empty for whole archives (the cultivar lived only in the report title, so
    // sixteen cherry tomato cultivars were compared as one), and a variant packed
    // in a bag inside a punnet trial was filed as a punnet. Nothing here writes;
    // it proposes, and the dashboard lets someone accept row by row.
    var TITLE_QUALIFIERS = /\b(on the vine|on vine|whole|processed|fresh[- ]cut|loose|trial|test)\b/gi;
    // A tail like this names a round or a shipment, never a cultivar.
    var NOT_A_CULTIVAR = /\b(round|ronde|ronda|r\d+|week|wk|shipment|arrival|batch|container|part|deel|sample|monster|control|reference)\b/i;
    function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // "Grower Punnet Trial 23-07-2020 - Variety 27 Cherry Tomato" -> "Variety 27":
    // the part after the last dash, minus the product's own names.
    function cultivarFromTitle(title, productNames) {
        var parts = String(title == null ? '' : title).split(/\s[-–—]\s/);
        if (parts.length < 2) return '';
        var tail = parts[parts.length - 1];
        (productNames || []).forEach(function (name) {
            var words = String(name || '').trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
            if (!words.length) return;
            words[words.length - 1] += '(?:e?s)?';
            tail = tail.replace(new RegExp('(^|[^\\w])' + words.join('\\s+') + '(?=$|[^\\w])', 'gi'), '$1 ');
        });
        tail = tail.replace(TITLE_QUALIFIERS, ' ').replace(/[(),;:]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!tail || tail.split(' ').length > 4) return '';
        if (/^[\d\s./-]+$/.test(tail) || NOT_A_CULTIVAR.test(tail)) return '';
        return tail;
    }
    // A packaging the variant's own name spells out ("PerfoTec C+ bag") wins over
    // the report's ("Punnets"): a bag tested in a punnet trial is a bag. Nothing
    // spelled out -> '' and the report decides.
    function variantPackType(name) {
        var r = String(name || '').toLowerCase();
        if (/\bpallet\b/.test(r)) return 'Pallet';
        if (/\b(flow ?pack|flow ?wrap|bag|pouch|pillow)\b/.test(r)) return 'Flowpack';
        if (/\b(punnet|tray|clamshell|top ?seal)\b/.test(r)) return 'Punnet';
        if (/\b(crate|box|liner)\b/.test(r)) return 'Crate/Box';
        return '';
    }
    // Where a row's report title can be read: the importer's note says
    // "(trial: <title>)", and older rows carry the title as their report reference.
    function trialTitlesOf(master, i) {
        var m = master || {};
        var out = [];
        var hit = String(m['pack_opt_' + i + '_notes'] || '').match(/\(trial:\s*([^)]+)\)/i);
        if (hit) out.push(hit[1].trim());
        var pdf = String(m['pack_opt_' + i + '_pdf'] || '').trim();
        if (pdf) out.push(pdf);
        return out;
    }
    // [{ i, field: 'variety' | 'type' | 'trans' | 'film', current, proposed, source, material, date }]
    // films: the register's films — a row without a film gets the one film its
    // report's film spec or its variant name names (matchFilm).
    function trialDataChecks(master, productNames, films) {
        var m = master || {};
        var n = trialRowCount(m);
        var out = [];
        for (var i = 0; i < n; i++) {
            var f = (function (idx) { return function (k) { var v = m['pack_opt_' + idx + '_' + k]; return v == null ? '' : String(v).trim(); }; })(i);
            if (!f('material') && !f('pdf') && !f('curve') && !f('rating')) continue;
            if (!f('variety')) {
                var titles = trialTitlesOf(m, i), cv = '', src = '';
                for (var t = 0; t < titles.length && !cv; t++) { cv = cultivarFromTitle(titles[t], productNames); src = titles[t]; }
                if (cv) out.push({ i: i, field: 'variety', current: '', proposed: cv, source: src, material: f('material'), date: f('date') });
            }
            var vt = variantPackType(f('material'));
            if (vt && vt !== normPackType(f('type'))) out.push({ i: i, field: 'type', current: f('type'), proposed: vt, source: f('material'), material: f('material'), date: f('date') });
            // No proposal for a TV — only a person with the report knows it. The
            // empty value makes the dashboard ask for it.
            if (f('trans') !== '' && plausibleTv(f('trans')) == null) out.push({ i: i, field: 'trans', current: f('trans'), proposed: '', source: 'Below what a film transmits on its own — probably the number of perforations', material: f('material'), date: f('date') });
            if (films && films.length && !f('film')) {
                var said = f('filmSpec') || f('material');
                // A control is the client's current packaging: never one of ours.
                var pool = trialRowRole(m, i) === 'reference' ? films.filter(function (x) { return x && !x.own; }) : films;
                var hit = matchFilm([f('filmSpec'), f('material')].join(' · '), pool);
                if (hit) out.push({ i: i, field: 'film', current: '', proposed: hit.id, source: said, material: f('material'), date: f('date') });
            }
        }
        return out;
    }

    // [{ card, status, summary }] for one product (or several ids: the
    // dashboard's 'All varieties' view). Ongoing first, then newest first.
    // `cards` may be passed in when the caller already has them.
    function readProductTrials(productIds, cards) {
        var ids = Array.isArray(productIds) ? productIds : [productIds];
        var src = cards ? Promise.resolve(cards) : readManifest().then(function (m) { return m.projects || []; });
        return src.then(function (list) {
            var mine = (list || []).filter(function (c) { return ids.some(function (id) { return isProductTrial(c, id); }); });
            return Promise.all(mine.map(function (c) {
                return readProjectData(c.id, 'report').catch(function () { return null; }).then(function (doc) {
                    return { card: c, status: trialStatus(c), summary: summariseTrial(doc) };
                });
            }));
        }).then(function (rows) {
            var dateOf = function (r) { return String(r.summary.packingDate || r.card.startDate || r.card.updatedAt || ''); };
            return rows.sort(function (a, b) {
                if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
                return dateOf(b).localeCompare(dateOf(a));
            });
        });
    }

    // ---- A trial report into its product's trial table ------------------------
    // One report becomes one row per variant in the product's trial table
    // (formData['p2-pack-master']: pack_opt_<i>_<field> plus packOptCount), and
    // fills the product's baseline properties that are still EMPTY — curated
    // values stay the master. Shared by the Product Dashboard's file import and
    // the board's import on a move to Dashboard, so both write the same rows.
    // A variant already in the table (same report reference, date and variant)
    // is skipped. Pure: returns { formData, imported, skipped, baselineFilled }
    // and writes nothing; formData is the one passed in when nothing changed.
    function reportNums(s) {
        return String(s == null ? '' : s).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/g) || [];
    }
    // Free-text packaging onto the table's fixed options (substring match).
    function reportPackType(raw) {
        var r = String(raw || '').toLowerCase();
        if (r.indexOf('pallet') >= 0) return 'Pallet';
        if (/punnet|tray|clamshell|topseal/.test(r)) return 'Punnet';
        if (/crate|box|liner/.test(r)) return 'Crate/Box';
        if (/flow|bag|pillow|pouch/.test(r)) return 'Flowpack';
        return 'Crate/Box';
    }
    // 'whole' | 'processed' | '' from a report's processing type.
    function reportState(report) {
        var p = (report && report.project) || {};
        var s = String(p.processingType || p.state || '').toLowerCase().replace(/[\s\-()\/]+/g, ' ').trim();
        return s.indexOf('process') >= 0 || s.indexOf('cut') >= 0 ? 'processed' : s.indexOf('whole') >= 0 ? 'whole' : '';
    }
    // A variant counts once something was measured on it: a quality score, or a
    // gas or weight reading after day 0 (day 0 holds the template's 20.9/0.03).
    // The template's empty 'Control' imported as a trial, and its row then kept
    // the real results out as "already there".
    function variantHasResults(g) {
        return ((g && g.measurements) || []).some(function (m) {
            if (!m) return false;
            if (measurementQuality(m)) return true;
            if (!(Number(m.day) > 0)) return false;
            return (m.samples || []).some(function (smp) {
                return smp && ['o2', 'co2', 'weight'].some(function (k) { return smp[k] != null && String(smp[k]).trim() !== ''; });
            });
        });
    }
    // How many rows the trial table holds. The dashboard always shows at least
    // one, and typing into that first row never set packOptCount: a filled row 0
    // is a trial, not free space. ('condition' shows MAP by default, so it does
    // not count as filled.)
    function trialRowCount(master) {
        var m = master || {};
        var n = parseInt(m.packOptCount, 10) || 0;
        if (n < 1 && Object.keys(m).some(function (k) {
            return /^pack_opt_0_/.test(k) && k !== 'pack_opt_0_condition' && m[k] != null && String(m[k]).trim() !== '';
        })) n = 1;
        return n;
    }
    // opts.projectId: the board project the report belongs to. Rows imported
    // with it carry that project and the variant's id (pack_opt_<i>_project /
    // _group), and those decide what is already in the table.
    function applyReportToProduct(formData, report, opts) {
        opts = opts || {};
        var projectId = opts.projectId ? String(opts.projectId) : '';
        var fd = formData || {};
        var result = { formData: fd, imported: 0, updated: 0, skipped: 0, baselineFilled: 0, noResults: 0 };
        if (!report || report.isPerfoTecReport !== true || !Array.isArray(report.groups)) return result;
        var copy = function (o) { var c = {}; Object.keys(o || {}).forEach(function (k) { c[k] = o[k]; }); return c; };
        var master = copy(fd['p2-pack-master']);
        var p1c1 = copy(fd['p1-core-1']), p1c2 = copy(fd['p1-core-2']), p1c3 = copy(fd['p1-core-3']);
        var count = trialRowCount(master);
        var nums = reportNums;
        // What is already in the table. A row the board imported names its
        // project and variant, so the trial is recognised by those: a title edited
        // afterwards does not make it look new, and another trial that happens to
        // share its title, date and variant names is not taken for it. Rows
        // without (the dashboard's own imports, older rows) match as they always
        // did, on report reference, date and variant name.
        // A stamp only counts while it still fits its own row (the _stamp holds
        // the row's material, report reference and date as they were when it was
        // written): an older dashboard moves those fields when it deletes a row,
        // but not the stamp, and a drifted stamp is then just ignored.
        var rowKey = function (p) { return String(master[p + 'material'] || '') + '|' + String(master[p + 'pdf'] || '') + '|' + String(master[p + 'date'] || ''); };
        var sigs = {}, mine = {};
        for (var i = 0; i < count; i++) {
            var p = 'pack_opt_' + i + '_';
            var rowProject = String(master[p + 'project'] || '');
            if (projectId && rowProject && String(master[p + 'stamp'] || '') === rowKey(p)) {
                if (rowProject === projectId) mine[String(master[p + 'group'] || '')] = { i: i, material: String(master[p + 'material'] || '') };
                continue;
            }
            var legacyKey = (String(master[p + 'pdf'] || '') + '|' + String(master[p + 'date'] || '') + '|' + String(master[p + 'material'] || '')).toLowerCase();
            // A row with neither rating nor curve is a placeholder an older import
            // wrote before the variant had results; its results may fill it later.
            if (!sigs[legacyKey]) sigs[legacyKey] = { i: i, placeholder: String(master[p + 'rating'] || '').trim() === '' && String(master[p + 'curve'] || '').trim() === '' };
        }
        var proj = report.project || {};
        var fillIfEmpty = function (obj, key, val) {
            if (val != null && val !== '' && (obj[key] == null ? '' : String(obj[key])).trim() === '') { obj[key] = String(val); return true; }
            return false;
        };
        // Trial storage temperature = the most frequent temperature among the
        // supply-chain stages, not proj.tempMin (the critical minimum).
        var chainTempCounts = {};
        (report.supplyChain || []).forEach(function (s) {
            var v = nums(s && s.tempStart)[0];
            if (v != null) chainTempCounts[v] = (chainTempCounts[v] || 0) + 1;
        });
        var tempKeys = Object.keys(chainTempCounts);
        var chainTemp = tempKeys.length
            ? tempKeys.map(function (k) { return [k, chainTempCounts[k]]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0]
            : (nums(proj.rrTemp)[0] || '');
        var reportDate = String(proj.packingDate || proj.date || '');
        // Trial Report column: the ORIGINAL source documents the data came from,
        // else the report title. It feeds the duplicate signature as well.
        var sourceDocs = Array.isArray(proj.sourceDocuments)
            ? proj.sourceDocuments.filter(Boolean).join('; ')
            : String(proj.sourceDocuments || '');
        var reportRef = sourceDocs || String(proj.reportTitle || '');
        var qualityOf = function (m) { var q = measurementQuality(m); return q ? String(q.value) : ''; };
        var namesInReport = {};
        report.groups.forEach(function (g) { if (g) namesInReport[String(g.name || (g.specs && g.specs.material) || '').toLowerCase()] = true; });
        report.groups.forEach(function (g) {
            g = g || {};
            var specs = g.specs || {};
            var variantName = g.name || String(specs.material ? specs.material : '');
            if (!variantHasResults(g)) { result.noResults++; return; }
            var sig = (reportRef + '|' + reportDate + '|' + variantName).toLowerCase();
            // The row this variant already has: for rows the board wrote, by
            // project and variant id (a renamed variant is still that variant,
            // unless its old name is still in the report: then the id went to
            // another one), else by report, date and name. A trial imported before
            // its last days were scored is brought up to date. It used to be
            // skipped as "already there", and a rename added it a second time.
            var own = projectId ? mine[String(g.id)] : null;
            if (own && own.material !== variantName && namesInReport[own.material.toLowerCase()]) own = null;
            var hit = own ? null : sigs[sig], reuse = -1, placeholder = false;
            if (hit === true) { result.skipped++; return; } // this variant twice in one report
            if (own) reuse = own.i;
            else if (hit) { reuse = hit.i; placeholder = hit.placeholder; }
            sigs[sig] = true;
            var sorted = (g.measurements || []).slice().sort(function (a, b) { return (Number(a.day) || 0) - (Number(b.day) || 0); });
            var lastMeas = sorted.length ? sorted[sorted.length - 1] : {};
            // Rating and its day describe the same moment: the last day with a quality.
            var lastRated = sorted.slice().reverse().filter(function (m) { return qualityOf(m) !== ''; })[0];
            // A day's value is the average of its samples, as the report shows it
            // (one decimal, the report's rounding). It used to be the first
            // sample only: one pack out of three. A gas reading outside 0-100 %
            // is a typing error and left out.
            var sampleValue = function (m, field) {
                var gas = field === 'o2' || field === 'co2';
                var vals = ((m && m.samples) || []).map(function (s) {
                    var n = s ? reportNums(s[field]) : [];
                    return n.length && String(s[field]).trim() !== '' ? parseFloat(n[0]) : NaN;
                }).filter(function (n) { return isFinite(n) && (!gas || (n >= 0 && n <= 100)); });
                if (!vals.length) return '';
                var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
                return String(Math.round(Number((avg * 10).toPrecision(12))) / 10);
            };
            var lastValid = function (field) { var f = sorted.slice().reverse().filter(function (m) { return sampleValue(m, field) !== ''; })[0]; return f ? sampleValue(f, field) : ''; };
            var firstValid = function (field) { var f = sorted.filter(function (m) { return sampleValue(m, field) !== ''; })[0]; return f ? sampleValue(f, field) : ''; };
            // The results of this variant.
            var res = {
                weight: firstValid('weight') || String(proj.startWeight || '') || String(specs.startWeight != null ? specs.startWeight : ''),
                o2: lastValid('o2'),
                co2: lastValid('co2'),
                days: lastRated ? String(lastRated.day) : (lastMeas.day != null ? String(lastMeas.day) : ''),
                rating: lastRated ? qualityOf(lastRated) : '',
                // The whole quality-over-time curve, "day:score|day:score|...".
                curve: sorted
                    .map(function (m) { return { day: Number(m.day) || 0, q: qualityOf(m) }; })
                    .filter(function (p) { return p.q !== ''; })
                    .map(function (p) { return p.day + ':' + p.q; }).join('|')
            };
            // The role set in the report tool ('reference' | 'perfotec'; blank: the
            // dashboard reads it from the name) and the round (2 = verification).
            var role = String(specs.role || '').toLowerCase();
            if (role !== 'reference' && role !== 'perfotec') role = '';
            var roundNo = Number(g.round) > 1 ? Number(g.round) : (g.verificationOf != null ? 2 : 0);
            // What an existing row takes from the report. Each row remembers what
            // the report said when it was last imported (pack_opt_i_src): a field
            // follows the report when the REPORT changed it since, and a value
            // corrected by hand in the dashboard (the report unchanged) stays. An
            // older row without that record takes empty fields, and the end result
            // when the report has scored more days since.
            var RESULT_FIELDS = ['o2', 'co2', 'days', 'rating', 'curve', 'weight'];
            // How it was packed: perforation, gas flush and the gas at packing —
            // the report's own start values, else its day-0 (P+0) measurement.
            // Filled where the row has none, so a row imported before these
            // fields existed takes them when its report is imported again.
            var pack = {};
            if (PACK_PERF[specs.perforation]) pack.perf = String(specs.perforation);
            if (PACK_FLUSH[specs.gasFlush]) pack.flush = String(specs.gasFlush);
            // The Hub package the proposal's simulation was run for, and a laser
            // program named in the report: the row's links into the Hub catalogue.
            var simulated = (g.prediction && g.prediction.inputs) || {};
            // (the package picked in the report tool wins over the simulated one)
            if (specs.hubPackage != null && String(specs.hubPackage).trim() !== '') pack.hubPackage = String(specs.hubPackage).trim();
            else if (simulated.hubPackageId != null && String(simulated.hubPackageId).trim() !== '') pack.hubPackage = String(simulated.hubPackageId).trim();
            if (specs.laserProgram != null && String(specs.laserProgram).trim() !== '') pack.laserProgram = String(specs.laserProgram).trim();
            var startGas = specs.startGas || {};
            var day0 = sorted.filter(function (m) { return Number(m.day) === 0; })[0];
            ['o2', 'co2'].forEach(function (k) {
                var v = reportNums(startGas[k]);
                var val = v.length ? String(parseFloat(v[0])) : (day0 ? sampleValue(day0, k) : '');
                if (val !== '') pack[k === 'o2' ? 'startO2' : 'startCO2'] = val;
            });
            var updates = {};
            if (reuse >= 0) {
                var old = 'pack_opt_' + reuse + '_';
                var cur = function (k) { return String(master[old + k] == null ? '' : master[old + k]); };
                var src = null;
                try { src = JSON.parse(cur('src') || 'null'); } catch (e) { src = null; }
                var was = function (k) { return src && src[k] != null ? String(src[k]) : ''; };
                if (placeholder) {
                    RESULT_FIELDS.forEach(function (k) { if (res[k] !== '') updates[k] = res[k]; });
                } else if (src) {
                    RESULT_FIELDS.forEach(function (k) { if (res[k] !== '' && res[k] !== was(k) && res[k] !== cur(k)) updates[k] = res[k]; });
                    if (src.material != null && variantName !== String(src.material) && variantName !== cur('material')) updates.material = variantName;
                } else {
                    var more = parseTrialCurve(res.curve).length > parseTrialCurve(cur('curve')).length;
                    RESULT_FIELDS.forEach(function (k) { if (res[k] !== '' && res[k] !== cur(k) && (cur(k) === '' || (more && k !== 'weight'))) updates[k] = res[k]; });
                    if (own && cur('material') !== variantName) updates.material = variantName;
                }
                var news = Object.keys(updates).length > 0 || (role && cur('role') !== role) || (roundNo > 1 && cur('round') !== String(roundNo))
                    || Object.keys(pack).some(function (k) { return cur(k).trim() === ''; });
                if (!news) { result.skipped++; return; }
            }
            var at = 'pack_opt_' + (reuse >= 0 ? reuse : count++) + '_';
            // A result the report does not have (no gas measured, say) never
            // blanks one the row already holds.
            var put = function (k, v) { if (reuse < 0) master[at + k] = v; else if (Object.prototype.hasOwnProperty.call(updates, k)) master[at + k] = updates[k]; };
            // A new row gets everything; a placeholder row gets its results, and the
            // descriptive fields only where they are still empty (hand edits stay).
            var fill = function (k, v) { if (reuse < 0 || String(master[at + k] == null ? '' : master[at + k]).trim() === '') master[at + k] = v; };
            fill('type', variantPackType(variantName) || reportPackType(specs.packaging));
            if (reuse < 0 || updates.material) master[at + 'material'] = variantName;
            fill('variety', String(proj.type || proj.variety || ''));
            fill('temp', chainTemp);
            // Pack weight: measured sample weight, else the project's, else the group spec.
            put('weight', res.weight);
            // Transmission value = number of laser perforations ("holes"), not holeSize.
            fill('trans', String(specs.holes != null && String(specs.holes).trim() !== '' ? specs.holes : ''));
            // The film as the report names it ("BOPP · 30 µm"): the dashboard's
            // data check proposes the register film from it. A report that picked
            // a register film (specs.filmId) links it straight away.
            var filmSpec = [String(specs.material == null ? '' : specs.material).trim(), String(specs.filmThickness == null ? '' : specs.filmThickness).trim()];
            if (filmSpec[1] && !/µm|um|mu/i.test(filmSpec[1])) filmSpec[1] += ' µm';
            if (filmSpec[0] || filmSpec[1]) fill('filmSpec', filmSpec.filter(Boolean).join(' · '));
            if (specs.filmId) fill('film', String(specs.filmId));
            Object.keys(pack).forEach(function (k) { fill(k, pack[k]); });
            put('o2', res.o2);
            put('co2', res.co2);
            fill('company', String(proj.company || ''));
            fill('country', String(proj.country || ''));
            put('days', res.days);
            put('rating', res.rating);
            master[at + 'date'] = reportDate;
            master[at + 'pdf'] = reportRef;
            var variantConcl = String((report.analysis && report.analysis.variantConclusions ? report.analysis.variantConclusions[String(g.id)] : '') || '');
            var sourceNote = sourceDocs ? 'Extracted from: ' + sourceDocs + (proj.reportTitle ? ' (trial: ' + proj.reportTitle + ')' : '') : '';
            fill('notes', variantConcl + (sourceNote ? (variantConcl ? '\n\n' : '') + sourceNote : ''));
            put('curve', res.curve);
            var rawAtm = String(specs.atmosphereStrategy || '').trim();
            fill('condition', rawAtm === 'Open' ? 'OPEN' : rawAtm === 'MHP' ? 'MHP' : 'MAP');
            if (role) master[at + 'role'] = role;
            else if (reuse < 0) delete master[at + 'role'];
            // A verification round (R2) is a round of its own: with its Round 1
            // it can make a result "proven".
            if (roundNo > 1) master[at + 'round'] = String(roundNo);
            else if (reuse < 0) delete master[at + 'round'];
            // What the report says now, for the next import to compare with.
            master[at + 'src'] = JSON.stringify({ o2: res.o2, co2: res.co2, days: res.days, rating: res.rating, curve: res.curve, weight: res.weight, material: variantName });
            if (projectId) {
                master[at + 'project'] = projectId;
                master[at + 'group'] = String(g.id);
                // The stamp describes the row as it now is (a name kept by hand included).
                master[at + 'stamp'] = String(master[at + 'material'] == null ? '' : master[at + 'material']) + '|' + reportRef + '|' + reportDate;
            } else if (reuse < 0) {
                // A new row in a slot an older dashboard left stamps in (it did not
                // move them). A board row brought up to date keeps its identity.
                delete master[at + 'project']; delete master[at + 'group']; delete master[at + 'stamp'];
            }
            if (reuse >= 0 && !placeholder) result.updated++;
            else result.imported++;
        });
        // Baseline product properties: only fields that are still empty.
        var acpN = nums(proj.acpO2), co2MaxN = nums(proj.co2Max), tempN = nums(proj.tempMin);
        var o2T = nums(proj.o2Target), co2T = nums(proj.co2Target);
        if (fillIfEmpty(p1c1, 'acp', acpN[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c1, 'critCO2', co2MaxN[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c1, 'minTemp', tempN[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c3, 'targetO2Min', o2T[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c3, 'targetO2Max', o2T[1] != null ? o2T[1] : o2T[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c3, 'targetCO2Min', co2T[0])) result.baselineFilled++;
        if (fillIfEmpty(p1c3, 'targetCO2Max', co2T[1] != null ? co2T[1] : co2T[0])) result.baselineFilled++;
        // Respiration rates measured with the FRM, at the measured temperature.
        var rrTempN = nums(proj.rrTemp)[0];
        if (rrTempN != null) {
            if (fillIfEmpty(p1c2, 'temp' + rrTempN + '_O2', nums(proj.rrO2)[0])) result.baselineFilled++;
            if (fillIfEmpty(p1c2, 'temp' + rrTempN + '_CO2', nums(proj.rrCO2)[0])) result.baselineFilled++;
        }
        if (!result.imported && !result.updated && !result.baselineFilled) return result;
        var next = copy(fd);
        if (result.imported || result.updated) { master.packOptCount = count; next['p2-pack-master'] = master; }
        if (result.baselineFilled) { next['p1-core-1'] = p1c1; next['p1-core-2'] = p1c2; next['p1-core-3'] = p1c3; }
        result.formData = next;
        return result;
    }

    // A board project's trial into the product it is LINKED to, on disk. Runs
    // when a card moves to Dashboard, and again from the note on the card. The
    // link is the authority: no guessing by product name (that once put "Flat
    // Bean" into "Green Beans"). Expected obstacles resolve rather than throw,
    // so the board can say what stands in the way:
    //   { ok: false, reason: 'no-card' | 'not-linked' | 'no-report' | 'not-a-report'
    //       | 'product-missing' | 'state-mismatch' | 'no-trial-data' | 'busy' }
    //   { ok: true, imported, skipped, baselineFilled, alreadyThere }
    // opts.force adds a trial whose processing state differs from the product's.
    // The card itself is not touched here: the board clears its note through its
    // own save path, which keeps its snapshot of the card in step.
    function importTrialIntoProduct(projectId, opts) {
        opts = opts || {};
        return readCard(projectId).then(function (card) {
            if (!card || card.deletedAt) return { ok: false, reason: 'no-card' };
            if (!card.productId) return { ok: false, reason: 'not-linked', productName: card.product || '' };
            return readPhaseFile(projectId, 'report').then(function (report) {
                if (!report) return { ok: false, reason: 'no-report' };
                if (report.isPerfoTecReport !== true || !Array.isArray(report.groups)) return { ok: false, reason: 'not-a-report' };
                var attempt = function (tries) {
                    return readProduct(card.productId).then(function (product) {
                        // (runs under the product's lock, see withProductLock below)
                        if (!product || product.deletedAt) return { ok: false, reason: 'product-missing', productId: card.productId, productName: card.product || '' };
                        var label = [product.name, product.variety].filter(Boolean).join(' ');
                        var rs = reportState(report);
                        if (rs && product.state && rs !== product.state && !opts.force) {
                            return { ok: false, reason: 'state-mismatch', reportState: rs, productState: product.state, productId: product.id, productName: label };
                        }
                        var r = applyReportToProduct(product.formData, report, { projectId: projectId });
                        // The trial is its variants: no new row means it is either in
                        // already, or has no results yet — never a write of baseline
                        // properties alone.
                        if (!r.imported && !r.updated) {
                            return r.skipped
                                ? { ok: true, alreadyThere: true, imported: 0, updated: 0, skipped: r.skipped, baselineFilled: 0, productId: product.id, productName: label }
                                : { ok: false, reason: 'no-trial-data', productId: product.id, productName: label };
                        }
                        var next = {};
                        Object.keys(product).forEach(function (k) { next[k] = product[k]; });
                        next.formData = r.formData;
                        return writeProductRecordUnlocked(next, { baseRev: product.rev }).then(function () {
                            return { ok: true, alreadyThere: false, imported: r.imported, updated: r.updated, skipped: r.skipped, baselineFilled: r.baselineFilled, productId: product.id, productName: label };
                        }, function (err) {
                            // Someone saved the product between the read and the
                            // write: build on their version instead (once).
                            if (err && err.code === 'CONFLICT') return tries < 1 ? attempt(tries + 1) : { ok: false, reason: 'busy', productId: product.id, productName: label };
                            throw err;
                        });
                    });
                };
                // Read, convert and write as one step per product, so two pushes
                // into it (two cards dragged in a row) queue instead of racing.
                return withProductLock(card.productId, function () { return attempt(0); });
            });
        });
    }

    // Read a project's data, preferring `preferPhase`'s file but falling back to
    // the most-advanced phase file that has REAL content (newest → oldest). This
    // makes a tool open with the latest meaningful content even when its own phase
    // file is missing OR is a blank stub that shadowed earlier data (the drag
    // "opens empty" bug). If nothing has content, returns the first file that
    // exists (so a genuinely new project still opens); null if none exist. An
    // emptied file ({}) does not count as existing: handed to a tool, it reads
    // as unrecognised and switches the autosave off.
    function readProjectData(projectId, preferPhase) {
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, false).then(function (dir) {
                var order = PHASES.map(function (p) { return p.key; });
                var files = [];
                if (preferPhase && PHASE_BY_KEY[preferPhase]) files.push(PHASE_BY_KEY[preferPhase].file);
                for (var i = order.length - 1; i >= 0; i--) {
                    if (order[i] !== preferPhase && order[i] !== 'dashboard') files.push(PHASE_BY_KEY[order[i]].file);
                }
                // Last resort: the CRM snapshot. A project that just arrived from
                // Pipedrive has no phase file with content yet, and without this
                // it would open as a blank form.
                files.push(SEED_FILE);
                function tryNext(idx, firstExisting) {
                    if (idx >= files.length) return firstExisting;
                    return readJSONFromDir(dir, files[idx]).then(function (d) {
                        if (d && hasContent(d)) return d;
                        return tryNext(idx + 1, firstExisting || (isEmptiedDoc(d) ? null : d) || null);
                    });
                }
                return tryNext(0, null);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        });
    }

    // ---- Project titles ------------------------------------------------------
    // A project's title is typed in the proposal and report tools
    // (project.reportTitle), which mirror it onto the card as they save. For a
    // card from before that the board shows it from the phase file — read, never
    // written back: a background write would race the board's own saves. And
    // only the head of the file: a report averages 8 MB and reaches 136 MB, the
    // title sits at the top (under 8 KB in every live file, September 2026).
    // Report first: it is the later of the two.
    var TITLE_HEAD_BYTES = 65536;
    // The tools' own placeholders are not a title anybody chose.
    var TITLE_PLACEHOLDERS = { 'quality report map test': 1, 'trial proposal': 1, 'trial voorstel': 1, 'propuesta de prueba': 1 };
    function projectTitle(raw) {
        var s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
        return TITLE_PLACEHOLDERS[s.toLowerCase()] ? '' : s;
    }
    function titleFromHead(text) {
        var m = /"reportTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text || '');
        if (!m) return '';
        try { return projectTitle(JSON.parse('"' + m[1] + '"')); } catch (e) { return ''; }
    }
    // What a file's head held, per browser, keyed on the file's size and date:
    // a file is read again only once it changed. Even a head read makes OneDrive
    // download the whole file when it is kept online-only.
    var TITLE_CACHE_KEY = 'perfotec-project-titles';
    function titleCache() {
        try { return JSON.parse(window.localStorage.getItem(TITLE_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function rememberTitle(key, file, title) {
        var c = titleCache();
        c[key] = { s: file.size, m: file.lastModified, t: title };
        try { window.localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(c)); } catch (e) { /* private mode */ }
    }
    function readProjectTitle(projectId) {
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, false);
        }).then(function (dir) {
            var files = [PHASE_BY_KEY.report.file, PHASE_BY_KEY.proposal.file];
            function tryNext(i) {
                if (i >= files.length) return '';
                var key = projectId + '/' + files[i];
                return dir.getFileHandle(files[i]).then(function (fh) {
                    return fh.getFile();
                }).then(function (file) {
                    var hit = titleCache()[key];
                    if (hit && hit.s === file.size && hit.m === file.lastModified) return hit.t || '';
                    return file.slice(0, TITLE_HEAD_BYTES).text().then(function (head) {
                        var t = titleFromHead(head);
                        rememberTitle(key, file, t);
                        return t;
                    });
                }).then(function (t) {
                    return t || tryNext(i + 1);
                }, function (err) {
                    if (err && err.name === 'NotFoundError') return tryNext(i + 1);
                    throw err;
                });
            }
            return tryNext(0);
        }).catch(function (err) {
            if (err && err.name === 'NotFoundError') return '';
            throw err;
        });
    }

    // The first `maxBytes` of a project's phase file as text, or null when the
    // file does not exist: a field written at the top of the document (the
    // report's docRev) without reading a 100 MB report.
    function readPhaseFileHead(projectId, phaseKey, maxBytes) {
        var phase = PHASE_BY_KEY[phaseKey];
        if (!phase) return Promise.reject(new Error('Unknown phase: ' + phaseKey));
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, false);
        }).then(function (dir) {
            return dir.getFileHandle(phase.file);
        }).then(function (fh) {
            return fh.getFile();
        }).then(function (file) {
            return file.slice(0, maxBytes || 4096).text();
        }).catch(function (err) {
            if (err && err.name === 'NotFoundError') return null;
            throw err;
        });
    }

    function writePhaseFile(projectId, phaseKey, dataObj) {
        var phase = PHASE_BY_KEY[phaseKey];
        if (!phase) return Promise.reject(new Error('Unknown phase: ' + phaseKey));
        return trackWrite(requireGrantedRoot().then(function (root) {
            return getProjectDir(root, projectId, true).then(function (dir) {
                return writeJSONToDir(dir, phase.file, dataObj);
            });
        }));
    }

    // ---- The documents of a copied project ------------------------------------
    // A copy is a NEW trial with the same set-up, so it gets its own documents.
    // Set-up documents (intake, proposal) are carried over as they are; a report
    // never is, because its measurements are the original trial's results.
    //   * With a set-up document to carry, the report is left out: the tools
    //     fall back to that document, and the board's forward-copy builds the
    //     copy's report from its own proposal when it gets there.
    //   * With only a report, its set-up (stripTrialResults) becomes the copy's
    //     PROPOSAL, the set-up document of a new trial. Kept as the copy's
    //     report instead, it outlived the proposal: move the copy back to
    //     Proposal, adjust it, move it on, and Report still showed the
    //     original's set-up, because the forward-copy never overwrites a
    //     report that has content.
    // Afterwards every report document the copy owns is checked for results and
    // stripped again if any got through. It is never emptied: until October 2026
    // this check compared the trial's shape, which a stripped report keeps by
    // design, so it emptied the copy's only document every time (isEmptiedDoc).
    // keys: the original's phase keys (its card's `files`). Resolves with the
    // copy's `files` map.
    function copyProjectFiles(sourceId, targetId, keys) {
        var files = {}, report = null, carried = false;
        // Accepted and Report share report.json: read and write each file once.
        var byFile = {}, order = [];
        (keys || []).forEach(function (k) {
            var ph = PHASE_BY_KEY[k];
            if (!ph) return;
            if (!byFile[ph.file]) { byFile[ph.file] = []; order.push(ph.file); }
            if (byFile[ph.file].indexOf(k) === -1) byFile[ph.file].push(k);
        });
        var chain = Promise.resolve();
        order.forEach(function (name) {
            var ks = byFile[name];
            chain = chain.then(function () {
                return readPhaseFile(sourceId, ks[0]).then(function (data) {
                    if (!data || !hasContent(data)) return;
                    if (data.isPerfoTecReport) { report = data; return; }
                    return writePhaseFile(targetId, ks[0], data).then(function () {
                        ks.forEach(function (k) { files[k] = true; });
                        carried = true;
                    });
                }).catch(function () { /* skip this document, keep the rest */ });
            });
        });
        return chain.then(function () {
            if (!report || carried) return;
            return writePhaseFile(targetId, 'proposal', stripTrialResults(report)).then(function () {
                files.proposal = true;
            }, function () { /* leave it out rather than write half a document */ });
        }).then(function () {
            var check = Promise.resolve();
            Object.keys(files).forEach(function (k) {
                check = check.then(function () {
                    return readPhaseFile(targetId, k).then(function (mine) {
                        if (!mine || !mine.isPerfoTecReport || !trialResultsIn(mine)) return;
                        if (typeof console !== 'undefined') console.warn('copyProjectFiles: results reached ' + k + ' of the copy, stripped them');
                        return writePhaseFile(targetId, k, stripTrialResults(mine));
                    }).catch(function () { /* written above from a set-up; leave it */ });
                });
            });
            return check;
        }).then(function () { return files; });
    }

    // A copy made before October 2026 could be left with nothing but an emptied
    // file (see copyProjectFiles). Opening it gives it its set-up from the
    // original after all — only when the copy holds nothing else, so nothing
    // anyone typed is ever replaced. Resolves with the files written ({} when
    // there was nothing to repair).
    function repairEmptiedCopy(copyId, sourceId, keys) {
        if (!copyId || !sourceId) return Promise.resolve({});
        var names = [];
        PHASES.forEach(function (p) { if (names.indexOf(p.file) === -1) names.push(p.file); });
        names.push(SEED_FILE);
        return requireGrantedRoot().then(function (root) {
            return getProjectDir(root, copyId, false).then(function (dir) {
                return Promise.all(names.map(function (n) { return readJSONFromDir(dir, n); }));
            }, function (err) {
                if (err && err.name === 'NotFoundError') return [];
                throw err;
            });
        }).then(function (docs) {
            var emptied = docs.some(isEmptiedDoc);
            var other = docs.some(function (d) { return d != null && !isEmptiedDoc(d); });
            if (!emptied || other) return {};
            return copyProjectFiles(sourceId, copyId, keys && keys.length ? keys : PHASES.map(function (p) { return p.key; }));
        });
    }

    // Best-effort removal of a project's folder. Manifest cleanup is the
    // caller's responsibility.
    function deleteProjectFiles(projectId) {
        return requireGrantedRoot().then(function (root) {
            return root.getDirectoryHandle(PROJECTS_DIR, { create: false }).then(function (dir) {
                return dir.removeEntry(projectId, { recursive: true });
            });
        }).catch(function (err) {
            if (err && err.name === 'NotFoundError') return; // nothing to remove
            throw err;
        });
    }

    // Generate a filesystem-safe project id.
    function newId() {
        return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    // Downscale an image (data URL or same-origin URL) to a small JPEG data URL
    // so the manifest stays lean when a tool pushes its product photo. Resolves
    // to null on any failure (caller then simply keeps no image).
    function scaleImage(src, maxW) {
        maxW = maxW || 480;
        return new Promise(function (resolve) {
            if (!src) { resolve(null); return; }
            try {
                var img = new Image();
                img.onload = function () {
                    try {
                        var scale = Math.min(1, maxW / img.width);
                        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
                        var c = document.createElement('canvas');
                        c.width = w; c.height = h;
                        c.getContext('2d').drawImage(img, 0, 0, w, h);
                        resolve(c.toDataURL('image/jpeg', 0.72));
                    } catch (e) { resolve(null); }
                };
                img.onerror = function () { resolve(null); };
                img.src = src;
            } catch (e) { resolve(null); }
        });
    }

    /* ======================================================================
     * Products — the Product Dashboard's collection, stored in the same root
     * ----------------------------------------------------------------------
     * Projects are client trials moving through phases; products are the
     * accumulated, trial-validated knowledge per produce type. They are
     * separate entities, but they belong in one database — a project's trial
     * results end up in a product, and both are the same body of work.
     *
     * Layout mirrors projects/: a light index for cheap listing, plus one file
     * per record for the heavy payload. A product's formData carries its
     * attached product-sheet HTML (~74 KB each), so a single combined file
     * would be rewritten in full on every debounced edit and would only grow
     * as more sheets get attached. Per-record files keep each write
     * proportional to what actually changed.
     *
     *     products/<productId>.json  full record incl. formData
     *
     * There is deliberately NO shared index file any more. products.json used to
     * hold one summary per product, and every session rewrote it WHOLE from the
     * list it happened to be holding — so a session that had never seen a product
     * someone else added wrote an index without it. The record file survived on
     * disk while the product vanished from the dashboard, the board and every
     * picker, silently. That is the same single-file lost update §3 of
     * TEAM_TEST_ARCHITECTUUR.md describes, and cards were split per file to avoid
     * it; products were left behind. The index is now DERIVED from a directory
     * listing, exactly as the board's card list is, so there is no longer a file
     * that everyone writes to.
     *
     * PRODUCT_INDEX is kept only to recognise the stale file left by the old
     * scheme. Nothing reads it for data and nothing writes it.
     * ==================================================================== */

    var PRODUCTS_DIR = 'products';
    var PRODUCT_INDEX = 'products.json';
    // Where a write that lost a race is parked. Losing a race must never mean
    // losing the work: the other version is on disk, this one is here.
    var PRODUCT_CONFLICT_DIR = '_conflicts';

    function emptyProductIndex() {
        return { schemaVersion: '1.0', isPerfoTecProducts: true, products: [] };
    }

    /* ----------------------------------------------------------------------
     * ALTERNATIVE PRODUCT NAMES ("aliases")
     * ----------------------------------------------------------------------
     * The same produce is sold under several names — Romano Beans, Flat Beans
     * and Italian Green Beans are one product. Each record therefore carries an
     * `aliases` list next to its `name`, and every place that searches for a
     * product searches those too. Only `name` is ever DISPLAYED: an alias is a
     * way in, never a second identity, so a trial found under "Flat Beans"
     * still lands on Romano Beans everywhere.
     * -------------------------------------------------------------------- */

    // Letters and digits only, so "Bimi®Broccolini" and "bimi broccolini" are
    // the same name. Shared by every product lookup in this file.
    function normaliseProductName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    // Clean an alias list for storage: trimmed, no blanks, no duplicates, and
    // never the product's own name — an alias that repeats the main name would
    // just be a second row saying nothing.
    function cleanAliases(list, ownName) {
        var seen = {};
        var own = normaliseProductName(ownName);
        if (own) seen[own] = true;
        return (Array.isArray(list) ? list : []).map(function (a) {
            return String(a || '').trim();
        }).filter(function (a) {
            var k = normaliseProductName(a);
            if (!k || seen[k]) return false;
            seen[k] = true;
            return true;
        });
    }

    // Every name this product answers to, main name first. Accepts a record or
    // an index summary — both carry `name` and `aliases`.
    function productNames(p) {
        return [(p && p.name) || ''].concat(cleanAliases(p && p.aliases, p && p.name))
            .filter(Boolean);
    }

    // The listing fields the board needs — deliberately without formData, so
    // reading the index never pulls in the attached sheet HTML.
    function productSummary(record) {
        var fd = record.formData || {};
        var sheet = fd['product-sheet'] || {};
        return {
            id: record.id,
            name: record.name || '',
            // Carried into the index so the board's product picker can search
            // the alternative names without reading every record file.
            aliases: cleanAliases(record.aliases, record.name),
            variety: record.variety || '',
            state: record.state || '',
            imageUrl: record.imageUrl || '',
            hasSheet: !!sheet.html,
            sheetFileName: sheet.fileName || '',
            // Provenance. These used to be here in name only: the summary read
            // `record.updatedAt`, and nothing ever set it, so every entry said
            // null. writeProductRecord stamps all three now, which is what makes
            // a lost edit diagnosable after the fact instead of deniable.
            rev: Number(record.rev || 0),
            updatedAt: record.updatedAt || null,
            updatedBy: record.updatedBy || ''
        };
    }

    function buildProductIndex(records) {
        var idx = emptyProductIndex();
        idx.products = (records || []).filter(function (r) { return r && r.id; }).map(productSummary);
        return idx;
    }

    function getProductsDir(root, create) {
        return root.getDirectoryHandle(PRODUCTS_DIR, { create: !!create });
    }

    // The product list, derived from the records on disk. No file backs this:
    // callers get the same shape they always did, built fresh from a directory
    // listing, so two people adding a product at the same time cannot write each
    // other's away.
    function readProductIndex() {
        return readAllProducts().then(function (records) {
            return buildProductIndex(records);
        });
    }

    // Deliberately does nothing. The index is derived (see readProductIndex), and
    // a shared file that every session rewrites whole is exactly the data loss
    // this change removes. Kept so a page still running the previous version of
    // this file — a tab left open, a cached copy — degrades to a no-op instead of
    // throwing, and so it cannot resurrect the stale products.json.
    function writeProductIndex() {
        return Promise.resolve(null);
    }

    // Is the superseded products.json still lying in the root? It is no longer
    // read or written, so it can only mislead: whoever opens the folder sees a
    // 400 KB file that looks like the product list and is frozen at the day this
    // change landed. Surfaced so the dashboard can say so rather than leave it.
    function legacyProductIndexPresent() {
        return requireGrantedRoot().then(function (root) {
            return readJSONFromDir(root, PRODUCT_INDEX);
        }).then(function (idx) {
            return !!(idx && Array.isArray(idx.products));
        }).catch(function () { return false; });
    }

    function readProduct(id) {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                return readJSONFromDir(dir, id + '.json');
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        });
    }

    function productConflictError(id, theirs) {
        var e = new Error('Product ' + id + ' was changed by ' +
            ((theirs && theirs.updatedBy) || 'someone else') + ' while you were editing it');
        e.code = 'CONFLICT';
        e.productId = id;
        e.theirs = theirs;
        return e;
    }

    // Park a record that lost a race under _conflicts/, named after the person
    // and the moment, so "their version won" never means "your work is gone".
    // Best effort on purpose: a failure to park must not swallow the conflict.
    function saveProductConflictCopy(record) {
        var who = String(getUserLabel() || 'me').replace(/[^A-Za-z0-9._-]+/g, '-');
        var stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return requireGrantedRoot().then(function (root) {
            return root.getDirectoryHandle(PRODUCT_CONFLICT_DIR, { create: true });
        }).then(function (dir) {
            return writeJSONToDir(dir, record.id + '--' + who + '--' + stamp + '.json', record);
        }).catch(function () { return null; });
    }

    // Write one product record under optimistic concurrency — the contract
    // writeCard has had all along and this never did. Without it, the dashboard
    // (which loads once and holds its list for the whole session) wrote a stale
    // snapshot straight over a colleague's finished trial data, with no error and
    // no trace.
    //   opts.baseRev  the rev this edit started from (default: record.rev)
    //   opts.force    write anyway, keeping the higher rev (user chose "mine")
    // Rejects with code 'CONFLICT' when the copy on disk moved on, having first
    // parked the caller's version under _conflicts/.
    // A rev that is not a finite number counts as 0. JSON.stringify turns NaN
    // into null, so one bad value would persist as "no rev" and quietly disable
    // conflict detection for that product from then on — the exact failure this
    // function exists to prevent.
    function revOf(v) {
        var n = Number(v);
        return isFinite(n) && n >= 0 ? n : 0;
    }

    // One product written at a time. Its rev check is a read and then a write,
    // so two writers overlapping in between both pass it and the later one wins
    // silently — two trials pushed into one product at once kept one. Web Locks
    // make it hold across this browser's tabs (board and dashboard share an
    // origin); a promise chain per product where they are missing. Other
    // machines are still only caught by the rev check itself.
    var _productChains = {};
    function withProductLock(id, fn) {
        if (typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function') {
            return navigator.locks.request('perfotec-product:' + id, function () { return fn(); });
        }
        var prev = _productChains[id] || Promise.resolve();
        var run = prev.then(fn, fn);
        _productChains[id] = run.then(function () { }, function () { });
        return run;
    }

    function writeProductRecord(record, opts) {
        if (!record || !record.id) return Promise.reject(new Error('Product needs an id'));
        return withProductLock(record.id, function () { return writeProductRecordUnlocked(record, opts); });
    }

    function writeProductRecordUnlocked(record, opts) {
        opts = opts || {};
        if (!record || !record.id) return Promise.reject(new Error('Product needs an id'));
        var baseRev = (opts.baseRev != null) ? revOf(opts.baseRev) : revOf(record.rev);
        // trackWrite spans the whole read-modify-write, not just the write: the
        // refresh-on-focus check in the dashboard asks hasPendingWrites() whether
        // it is safe to re-read, and re-reading between the read and the write
        // here would show the file as it was before the change.
        return trackWrite(readProduct(record.id).then(function (onDisk) {
            var diskRev = onDisk ? revOf(onDisk.rev) : 0;
            if (onDisk && diskRev !== baseRev && !opts.force) {
                return saveProductConflictCopy(record).then(function () {
                    throw productConflictError(record.id, onDisk);
                });
            }
            var next = {};
            Object.keys(record).forEach(function (k) { next[k] = record[k]; });
            next.rev = Math.max(diskRev, baseRev) + 1;
            next.updatedAt = new Date().toISOString();
            next.updatedBy = getUserLabel() || next.updatedBy || '';
            return requireGrantedRoot().then(function (root) {
                return getProductsDir(root, true);
            }).then(function (dir) {
                return writeJSONToDir(dir, next.id + '.json', next);
            }).then(function () { return next; });
        }));
    }

    // Single-product save. There is no index entry to keep in step any more —
    // the list is derived from the records themselves.
    function writeProduct(record, opts) {
        return writeProductRecord(record, opts);
    }

    // Tombstone a product: keep the record, stamp it, drop it from the index. It
    // stops appearing everywhere the index feeds (board, pickers, dashboard) but
    // the trial history is still on disk and restoreProduct brings it back.
    // purgeProduct below is the only thing that really erases one.
    // The tombstone is what hides the product now — readAllProducts filters on
    // deletedAt — so there is no index entry left to remove. force, because the
    // record was just read from disk and the delete is the user's decision, not
    // an edit racing someone else's.
    // Read and write as one step under the product's lock: read outside it, a
    // trial imported in between was written over by the tombstone.
    function deleteProduct(id) {
        return withProductLock(id, function () {
            return readProduct(id).then(function (rec) {
                if (!rec) return null;
                rec.deletedAt = new Date().toISOString();
                return writeProductRecordUnlocked(rec, { baseRev: rec.rev, force: true });
            });
        });
    }

    function restoreProduct(id) {
        return withProductLock(id, function () {
            return readProduct(id).then(function (rec) {
                if (!rec) return null;
                // Remove the key rather than nulling it, so a restored product is
                // indistinguishable from one that was never deleted.
                delete rec.deletedAt;
                return writeProductRecordUnlocked(rec, { baseRev: rec.rev, force: true });
            });
        });
    }

    // Everything in the recycle bin, newest first.
    function readDeletedProducts() {
        return listProductIds().then(function (ids) {
            var out = [];
            function step(i) {
                if (i >= ids.length) {
                    out.sort(function (a, b) { return String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')); });
                    return out;
                }
                return readProduct(ids[i]).then(function (rec) {
                    if (rec && rec.id && rec.deletedAt) out.push(rec);
                    return step(i + 1);
                });
            }
            return Promise.resolve(step(0));
        });
    }

    // Really erase a product record. Deliberately explicit and never automatic:
    // nothing in here expires a tombstone on a timer, because a deleter running
    // unattended is how the thing you wanted back disappears.
    function purgeProduct(id) {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                return dir.removeEntry(id + '.json');
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return; // already gone
                throw err;
            });
        });
    }

    // Cheap staleness probe: size and mtime of every record file, without
    // reading a byte of content. The dashboard holds its product list for a whole
    // session, so it needs a way to notice the folder moved under it that does
    // not cost 2 MB of reads every time the tab regains focus.
    function readProductStamps() {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                var out = {};
                var it = dir.values();
                function step() {
                    return it.next().then(function (res) {
                        if (res.done) return out;
                        var e = res.value;
                        if (e.kind !== 'file' || !/\.json$/i.test(e.name) || isSyncArtefact(e.name)) return step();
                        return e.getFile().then(function (f) {
                            out[e.name.replace(/\.json$/i, '')] = f.size + ':' + f.lastModified;
                            return step();
                        }).catch(function () { return step(); });
                    });
                }
                return step();
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return {};
                throw err;
            });
        });
    }

    // Conflict copies seen during the last products/ listing, so the dashboard
    // can warn instead of pretending the folder is clean. The cards side has had
    // this since the split; products had nothing, which is why the OneDrive copy
    // already sitting in this database was only ever found by hand.
    var _lastProductArtefacts = [];

    // Enumerate the record files on disk. This is now the source of truth for
    // which products exist — there is no index to heal.
    function listProductIds() {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                var ids = [], artefacts = [];
                var it = dir.values();
                function step() {
                    return it.next().then(function (res) {
                        if (res.done) { _lastProductArtefacts = artefacts; return ids; }
                        var entry = res.value;
                        if (entry.kind === 'file' && /\.json$/i.test(entry.name)) {
                            if (isSyncArtefact(entry.name)) artefacts.push(PRODUCTS_DIR + '/' + entry.name);
                            else ids.push(entry.name.replace(/\.json$/i, ''));
                        }
                        return step();
                    });
                }
                return step();
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') { _lastProductArtefacts = []; return []; }
                throw err;
            });
        });
    }

    // Every full product record, straight from the directory listing. This is
    // the primitive the derived index is built on; it no longer consults a file
    // that could hide real data.
    //
    // Read one at a time rather than with Promise.all: product records carry
    // formData, embedded photos and sometimes a whole product sheet, so they are
    // an order of magnitude bigger than a card, and firing them all at a synced
    // folder at once is how a slow read turns into a timeout.
    function readAllProducts(includeDeleted) {
        return listProductIds().then(function (ids) {
            var byId = {}, kept = [];
            function keep(rec, fileId) {
                if (!rec) return;
                if (!rec.id) rec.id = fileId;            // heal a hand-copied file
                // A record file is named after the id inside it. When it is not,
                // this is not that product — it is a copy of it. SharePoint names
                // conflict copies after the PERSON ("apple-Elisa.json"), which no
                // machine-name pattern catches, and the copy keeps the original
                // id. Loading it gave two records with one id, and every save
                // then fought over one file.
                if (rec.id !== fileId) { _lastProductArtefacts.push(PRODUCTS_DIR + '/' + fileId + '.json'); return; }
                if (!includeDeleted && rec.deletedAt) return;
                var prev = byId[rec.id];
                if (!prev) { byId[rec.id] = rec; kept.push(rec); return; }
                // Two files claiming one id must never both reach the dashboard.
                // Keep the newer and report the other.
                _lastProductArtefacts.push(PRODUCTS_DIR + '/' + rec.id + '.json (duplicate id)');
                var prevAt = Date.parse(prev.updatedAt || 0) || 0;
                var thisAt = Date.parse(rec.updatedAt || 0) || 0;
                if (thisAt > prevAt || (thisAt === prevAt && Number(rec.rev || 0) > Number(prev.rev || 0))) {
                    kept[kept.indexOf(prev)] = rec;
                    byId[rec.id] = rec;
                }
            }
            function step(i) {
                if (i >= ids.length) return kept;
                return readProduct(ids[i]).then(function (rec) {
                    keep(rec, ids[i]);
                    return step(i + 1);
                }).catch(function () { return step(i + 1); });
            }
            return Promise.resolve(step(0));
        });
    }

    // Has this root been set up for products yet? Drives the dashboard's
    // one-time migration prompt.
    function hasProductStore() {
        return listProductIds().then(function (ids) {
            if (ids.length > 0) return true;
            // An existing database whose products/ is momentarily unreadable must
            // not be mistaken for a fresh folder and offered the one-time import,
            // so the superseded index still counts as proof the store exists.
            return legacyProductIndexPresent();
        }).catch(function () { return false; });
    }

    // Migrate a PerfoTec_Database.json payload ({products:[…]}) into the store.
    // Existing records with the same id are overwritten; anything already there
    // under a different id is left alone. Returns the number written.
    //
    // force, because a backup file carries no rev: without it every record that
    // already exists here would read as a conflict against itself. Restoring a
    // backup over live data is the user's explicit decision, and the version it
    // replaces is parked by the normal conflict path only when they did not ask
    // for it — so the overwrite is stated plainly in the dashboard's prompt.
    function importProductBackup(backup) {
        var records = (backup && Array.isArray(backup.products)) ? backup.products : [];
        var usable = records.filter(function (r) { return r && r.id && !r.isAverage; });
        if (usable.length === 0) return Promise.resolve(0);
        function step(i) {
            if (i >= usable.length) return Promise.resolve(usable.length);
            return writeProductRecord(usable[i], { force: true }).then(function () { return step(i + 1); });
        }
        return step(0);
    }

    // Build the id the Product Dashboard would give this product, so a product
    // created from another tool is indistinguishable from one made there.
    // Same scheme as the dashboard's create-product flow: name-variety-state,
    // lowercased, every non-alphanumeric run collapsed to a dash, with a
    // timestamp suffix only when that id is already taken.
    function makeProductId(prod, existingIds) {
        var base = ((prod.name || '') + '-' + (prod.variety || 'base') + '-' + (prod.state || 'whole'))
            .toLowerCase().replace(/[^a-z0-9]/g, '-');
        var taken = existingIds || [];
        return taken.indexOf(base) === -1 ? base : base + '-' + Date.now();
    }

    // A blank product record in the dashboard's shape. `formData` stays empty:
    // the trial data, targets and product sheet are filled in later, in the
    // dashboard, by whoever runs the trial.
    function newProductRecord(prod, existingIds) {
        var name = (prod.name || '').trim();
        var variety = (prod.variety || '').trim();
        var state = prod.state === 'processed' ? 'processed' : 'whole';
        return {
            id: makeProductId({ name: name, variety: variety, state: state }, existingIds),
            name: name,
            aliases: cleanAliases(prod.aliases, name),
            variety: variety,
            state: state,
            targets: [],
            imageUrl: '',
            createdAt: new Date().toISOString(),
            completedTaskIds: [],
            links: {},
            formData: {}
        };
    }

    // Match a free-text product name against the store, so existing board
    // projects (which only carry `product` as text) can be linked without
    // retyping. Compares on letters and digits only, so "Bimi®Broccolini" and
    // "bimi broccolini" resolve to the same product. Alternative names count as
    // fully as the main one — a project typed up as "Flat Beans" links to
    // Romano Beans.
    function resolveProductId(name, index) {
        var want = normaliseProductName(name);
        if (!want) return Promise.resolve(null);
        var find = function (idx) {
            var list = (idx && idx.products) || [];
            var exact = null, partial = null;
            for (var i = 0; i < list.length; i++) {
                var names = productNames(list[i]);
                var variety = normaliseProductName(list[i].variety);
                for (var n = 0; n < names.length; n++) {
                    var bare = normaliseProductName(names[n]);
                    if (bare + variety === want || bare === want) { exact = list[i].id; break; }
                    if (!partial && (bare.indexOf(want) === 0 || want.indexOf(bare) === 0) && bare.length > 2) partial = list[i].id;
                }
                if (exact) break;
            }
            return exact || partial || null;
        };
        if (index) return Promise.resolve(find(index));
        return readProductIndex().then(find);
    }

    /* ======================================================================
     * "Back to the board" — one shared, always-available button
     * ----------------------------------------------------------------------
     * Every workflow step must offer a way back to the board. Each tool used to
     * render its own "← Board" link INSIDE the blue project banner, which only
     * appears when the page was opened from the board (?boardProject=...) and the
     * folder permission held. Open a tool directly, or hit a permission error, and
     * the user was stranded.
     *
     * Injecting the button here — once, from the shared layer, outside every
     * tool's React tree — fixes that for all pages at the same time and cannot be
     * switched off by tool state. It carries its own styles because the product
     * dashboard does not load style.css.
     * ==================================================================== */

    var LEAVE_TEXT = {
        en: {
            label: 'Board', title: 'Back to the Project Board', saving: 'Saving…',
            unsaved: 'Your last changes have not been saved yet — the database folder is not responding.\n\nLeave anyway and lose them?\n\nCancel to stay on this page and try again.',
        },
        nl: {
            label: 'Board', title: 'Terug naar het Project Board', saving: 'Opslaan…',
            unsaved: 'Je laatste wijzigingen zijn nog niet opgeslagen — de databasemap reageert niet.\n\nToch weggaan en ze kwijtraken?\n\nAnnuleer om op deze pagina te blijven en het opnieuw te proberen.',
        },
        es: {
            label: 'Board', title: 'Volver al Project Board', saving: 'Guardando…',
            unsaved: 'Tus últimos cambios aún no se han guardado — la carpeta de la base de datos no responde.\n\n¿Salir de todos modos y perderlos?\n\nCancela para quedarte en esta página e intentarlo de nuevo.',
        }
    };
    function leaveText() {
        var lang = '';
        try { lang = localStorage.getItem('perfotec_lang') || ''; } catch (e) { /* private mode */ }
        return LEAVE_TEXT[lang] || LEAVE_TEXT.en;
    }

    // Tools register a callback that writes any debounced-but-unsaved edits
    // immediately. Without this, clicking "Board" inside the ~1.2s autosave
    // debounce would discard the user's last change.
    var _flushHandlers = [];
    function registerFlush(fn) {
        if (typeof fn === 'function' && _flushHandlers.indexOf(fn) === -1) _flushHandlers.push(fn);
        return function () {
            var i = _flushHandlers.indexOf(fn);
            if (i !== -1) _flushHandlers.splice(i, 1);
        };
    }

    // Resolve once every in-flight write has drained (bounded, so a stuck write
    // can never trap the user on the page).
    // Resolves true when the queue actually drained, false when the deadline
    // ran out with writes still in flight. The caller needs to know which:
    // navigating away on `false` discards those writes.
    function waitForWrites(maxMs) {
        var deadline = Date.now() + (maxMs || 3000);
        return new Promise(function (resolve) {
            (function poll() {
                if (_pendingWrites <= 0) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 60);
            })();
        });
    }

    // Run every registered flush, then wait for the resulting writes. Always
    // resolves — navigation must never be blocked by a failing save.
    //
    // Resolves { ok: true } only when every handler succeeded AND the write
    // queue drained inside the deadline. It used to resolve undefined in all
    // cases, which hid two ways of losing an edit: a flush handler that
    // rejected (permission lapsed, folder gone) was swallowed by the bare
    // .catch, and a slow folder that outran the guard let the caller navigate
    // with writes still in flight — tearing the page down mid-write. Neither is
    // hypothetical here: this data lives on OneDrive/SharePoint, where a sync
    // lock can block a write for several seconds.
    //
    // The bound itself stays. Trapping the user on a hung write would be worse;
    // the caller just has to stop pretending the save succeeded.
    function flushPendingWork(maxMs) {
        var handlerFailed = false;
        var jobs = _flushHandlers.map(function (fn) {
            try {
                return Promise.resolve(fn()).catch(function () { handlerFailed = true; });
            } catch (e) {
                handlerFailed = true;
                return Promise.resolve();
            }
        });
        var settled = Promise.all(jobs).then(function () {
            return waitForWrites(maxMs);
        }).then(function (drained) {
            return { ok: drained && !handlerFailed, reason: !drained ? 'timeout' : (handlerFailed ? 'handler-failed' : null) };
        });
        // Outer guard: even waitForWrites' own deadline can be outlived by a
        // handler that never settles.
        var guard = new Promise(function (resolve) {
            setTimeout(function () { resolve({ ok: false, reason: 'timeout' }); }, (maxMs || 3000) + 1200);
        });
        return Promise.race([settled, guard]);
    }

    function boardUrl() {
        try { return new URL('board.html', _scriptUrl || window.location.href).href; }
        catch (e) { return 'board.html'; }
    }

    function isBoardPage() {
        if (window.PERFOTEC_NO_BACK_BUTTON) return true;
        var here = (window.location.pathname || '').split('/').pop().toLowerCase();
        return here === 'board.html';
    }

    // ---- Phase helpers ------------------------------------------------------
    // Moving a project to the next phase is deliberately ONLY possible on the
    // board, by dragging the card. The tools used to offer a "Next: <phase>"
    // button that did it from here too, which meant a phase could change from
    // two places under two sets of rules. The board owns that decision now.
    // What is left below are pure helpers: they answer questions, they move
    // nothing.

    function decodeSeg(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }

    // Which phase does the current page own? Derived from the filename so no tool
    // has to declare it.
    function currentPhaseKey() {
        var here = decodeSeg((window.location.pathname || '').split('/').pop()).toLowerCase();
        for (var i = 0; i < PHASES.length; i++) {
            if (decodeSeg(PHASES[i].tool.split('/').pop()).toLowerCase() === here) return PHASES[i].key;
        }
        return null;
    }

    function nextPhaseOf(phaseKey) {
        for (var i = 0; i < PHASES.length - 1; i++) {
            if (PHASES[i].key === phaseKey) return PHASES[i + 1];
        }
        return null;
    }

    function toolUrl(phase, projectId) {
        var base;
        try { base = new URL(phase.tool, boardUrl()).href; }
        catch (e) { base = phase.tool; }
        var url = base + '?boardProject=' + encodeURIComponent(projectId);
        if (phase.key === 'dashboard') url += '&autoImport=1';
        return url;
    }

    function currentProjectId() {
        try { return new URLSearchParams(window.location.search).get('boardProject'); }
        catch (e) { return null; }
    }

    // Flush unsaved work, then navigate to the board.
    function goToBoard() {
        var btn = document.querySelector('[data-perfotec-back-to-board]');
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.75';
            var lbl = btn.querySelector('[data-ptb-label]');
            if (lbl) lbl.textContent = leaveText().saving;
        }
        return flushPendingWork(3000).then(function (res) {
            // The save is bounded so a hung folder cannot trap anyone here. But
            // if it did not finish, navigating now throws the edit away — and
            // the button has been showing "Saving…" the whole time, so the user
            // would have every reason to think it landed. Ask instead.
            if (res && res.ok === false) {
                var stay = !window.confirm(leaveText().unsaved);
                if (stay) {
                    if (btn) {
                        btn.disabled = false;
                        btn.style.opacity = '';
                        if (lbl) lbl.textContent = leaveText().label;
                    }
                    return;
                }
            }
            window.location.assign(boardUrl());
        });
    }

    function mountBackToBoardButton() {
        if (isBoardPage()) return;
        if (!document.body) return;
        if (document.querySelector('[data-perfotec-back-to-board]')) return;

        var txt = leaveText();

        var style = document.createElement('style');
        style.setAttribute('data-ptb-style', '');
        // Own print rule: the hub tools hide every button when printing via
        // style.css, but the dashboard does not load it.
        style.textContent =
            '[data-ptb-bar]{position:fixed;left:16px;bottom:16px;z-index:45;display:flex;' +
            'align-items:center;gap:8px;font-family:Montserrat,ui-sans-serif,system-ui,sans-serif}' +
            '[data-ptb-bar] button{display:inline-flex;align-items:center;gap:8px;' +
            'padding:10px 16px;border:none;border-radius:9999px;cursor:pointer;' +
            'font-size:13px;font-weight:700;letter-spacing:.02em;color:#fff;' +
            'transition:background .15s,box-shadow .15s,transform .15s}' +
            '[data-perfotec-back-to-board]{background:#084BCD;padding-left:13px;' +
            'box-shadow:0 6px 20px rgba(8,75,205,.35)}' +
            '[data-perfotec-back-to-board]:hover{background:#0640ad;box-shadow:0 8px 26px rgba(8,75,205,.45);transform:translateY(-1px)}' +
            '[data-ptb-bar] button:focus-visible{outline:3px solid #1A1B1F;outline-offset:2px}' +
            '[data-ptb-bar] button[disabled]{cursor:progress;opacity:.75;transform:none}' +
            '@media print{[data-ptb-bar],[data-ptb-style]{display:none !important}}' +
            '@media (max-width:520px){[data-ptb-bar]{left:12px;bottom:12px}' +
            '[data-ptb-bar] button{padding:9px 13px;font-size:12px}}';
        document.head.appendChild(style);

        var bar = document.createElement('div');
        bar.setAttribute('data-ptb-bar', '');
        bar.className = 'no-print';           // honoured by style.css in the hub tools

        var btn = document.createElement('button');
        btn.setAttribute('data-perfotec-back-to-board', '');
        btn.setAttribute('type', 'button');
        btn.className = 'no-print';
        btn.title = txt.title;
        btn.setAttribute('aria-label', txt.title);
        btn.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>' +
            '<span data-ptb-label></span>';
        btn.querySelector('[data-ptb-label]').textContent = txt.label;
        btn.addEventListener('click', function () { goToBoard(); });
        bar.appendChild(btn);
        document.body.appendChild(bar);
    }

    function autoMount() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountBackToBoardButton);
        } else {
            mountBackToBoardButton();
        }
    }
    autoMount();

    /* ========================================================================
     * SHARED / MULTI-USER STORE  (schema 2.0)
     * ------------------------------------------------------------------------
     * Everything above this line assumes a single user: board.json holds every
     * project and is rewritten whole on every mutation. With two people on one
     * folder that loses data — A reads, B reads, A writes, B writes, A's change
     * is gone — and on a synced folder (OneDrive/SharePoint) it also produces
     * conflict copies. See TEAM_TEST_ARCHITECTUUR.md §3.
     *
     * So a project card becomes ONE FILE:
     *
     *     meta.json            presence of this file = cards mode is active
     *     people.json          shared registry (commercials / product managers)
     *     cards/<id>.json      one card, ~2-6 KB, carries rev/updatedAt/updatedBy
     *     board.json.pre-split the original, kept after migration
     *
     * projects/, products/ and .sync/ are deliberately left where they are:
     * moving them would mean copying ~100 MB through the browser and would break
     * pipedrive-sync.mjs for no benefit.
     *
     * Two people on different cards now touch different files and cannot
     * collide at all. Two people on the SAME card are caught by the rev rule:
     * re-read immediately before writing, and refuse to overwrite a newer
     * revision instead of silently winning.
     *
     * All new code goes through the IO adapter below rather than calling the
     * File System Access API directly, so the Graph implementation (phase 5) is
     * a second adapter and not a rewrite. The legacy functions above still call
     * FSA directly; they move over in phase 5.
     * ==================================================================== */

    var META_FILE = 'meta.json';
    var PEOPLE_FILE = 'people.json';
    var CARDS_DIR = 'cards';
    var LEGACY_BACKUP_NAME = 'board.json.pre-split';
    var DB_SCHEMA = '2.0';

    // Files a sync client leaves behind: OneDrive conflict copies
    // ("board-LAPTOP-ANNA.json"), Office lock files, Explorer duplicates.
    // Never parsed as data — surfaced to the UI instead, because silently
    // ignoring a conflict copy hides the fact that someone's edit went missing.
    function isSyncArtefact(name) {
        return /^~\$/.test(name) ||
               / - Copy\b/i.test(name) ||
               /-(?:LAPTOP|DESKTOP|PC|MACBOOK)-[^.]*\.json$/i.test(name);
    }

    // ---- IO adapter ---------------------------------------------------------
    // `path` is always an array of segments: ['cards', 'p_x.json']. A Graph
    // adapter joins them into a drive path; this one walks directory handles.
    var IO = {
        _dir: function (path, create) {
            return requireGrantedRoot().then(function (root) {
                var segs = path.slice(0, -1);
                return segs.reduce(function (p, seg) {
                    return p.then(function (dir) {
                        return dir.getDirectoryHandle(seg, { create: !!create });
                    });
                }, Promise.resolve(root));
            });
        },
        readJSON: function (path) {
            return IO._dir(path, false).then(function (dir) {
                return readJSONFromDir(dir, path[path.length - 1]);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        },
        writeJSON: function (path, obj) {
            return trackWrite(IO._dir(path, true).then(function (dir) {
                return writeJSONToDir(dir, path[path.length - 1], obj);
            }));
        },
        // Entries of a directory: [{ name, kind }]. Empty when it does not exist.
        list: function (path) {
            return requireGrantedRoot().then(function (root) {
                return path.reduce(function (p, seg) {
                    return p.then(function (dir) { return dir.getDirectoryHandle(seg, { create: false }); });
                }, Promise.resolve(root));
            }).then(function (dir) {
                var out = [];
                var it = dir.values();
                function step() {
                    return it.next().then(function (res) {
                        if (res.done) return out;
                        out.push({ name: res.value.name, kind: res.value.kind });
                        return step();
                    });
                }
                return step();
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return [];
                throw err;
            });
        },
        remove: function (path, recursive) {
            return IO._dir(path, false).then(function (dir) {
                return dir.removeEntry(path[path.length - 1], { recursive: !!recursive });
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return;
                throw err;
            });
        },
        // Streamed copy — never buffers the file in memory, so a 65 MB report
        // export costs the same as a 6 KB card.
        copyFile: function (fromPath, toPath) {
            return IO._dir(fromPath, false).then(function (dir) {
                return dir.getFileHandle(fromPath[fromPath.length - 1]);
            }).then(function (fh) {
                return fh.getFile();
            }).then(function (file) {
                return IO._dir(toPath, true).then(function (dir) {
                    return dir.getFileHandle(toPath[toPath.length - 1], { create: true });
                }).then(function (outFh) {
                    return outFh.createWritable();
                }).then(function (writable) {
                    return file.stream().pipeTo(writable);
                });
            });
        },
        stat: function (path) {
            return IO._dir(path, false).then(function (dir) {
                return dir.getFileHandle(path[path.length - 1]);
            }).then(function (fh) {
                return fh.getFile();
            }).then(function (file) {
                return { size: file.size, lastModified: file.lastModified };
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
        }
    };

    // ---- Who am I -----------------------------------------------------------
    // Stamped into every write so the UI can say WHO changed a card. Not a
    // security boundary — it is a label, and the user can change it. Real
    // identity arrives with the Graph login in phase 5.
    var WHOAMI_KEY = 'perfotec-board-user';
    function getUserLabel() {
        try { return window.localStorage.getItem(WHOAMI_KEY) || ''; } catch (e) { return ''; }
    }
    function setUserLabel(name) {
        try { window.localStorage.setItem(WHOAMI_KEY, String(name || '').trim()); } catch (e) { /* private mode */ }
        return getUserLabel();
    }

    // ---- meta.json / mode ---------------------------------------------------
    var _metaCache = null;
    function readMeta() {
        if (_metaCache) return Promise.resolve(_metaCache);
        return IO.readJSON([META_FILE]).then(function (m) {
            _metaCache = (m && m.isPerfoTecBoardDb) ? m : null;
            return _metaCache;
        });
    }

    // 'cards' once meta.json exists, 'legacy' while the store is still one
    // board.json. Everything reading/writing projects goes through the shim
    // below, so callers never have to care which one they are on.
    function dbMode() {
        return readMeta().then(function (m) { return m ? 'cards' : 'legacy'; });
    }

    function writeMeta(meta) {
        _metaCache = meta;
        return IO.writeJSON([META_FILE], meta);
    }

    // ---- cards --------------------------------------------------------------
    function cardPath(id) { return [CARDS_DIR, id + '.json']; }

    // Conflict copies found during the last read, so the board can warn instead
    // of pretending the folder is clean.
    var _lastArtefacts = [];
    function listCardIds() {
        return IO.list([CARDS_DIR]).then(function (entries) {
            var ids = [], artefacts = [];
            entries.forEach(function (e) {
                if (e.kind !== 'file' || !/\.json$/i.test(e.name)) return;
                if (isSyncArtefact(e.name)) { artefacts.push(e.name); return; }
                ids.push(e.name.replace(/\.json$/i, ''));
            });
            _lastArtefacts = artefacts;
            return ids;
        });
    }

    // Everything the last read found that should not be there: conflict copies in
    // cards/, in products/, and now in the root as well. The root was the gap
    // that mattered most — a "products - Copy.json" beside the database was the
    // one artefact nothing looked for, because nothing ever listed the root.
    function lastSyncArtefacts() {
        return _lastArtefacts.concat(_lastProductArtefacts, _lastRootArtefacts);
    }

    var _lastRootArtefacts = [];
    var _lastDeletedStamps = [];

    // List the root itself for sync artefacts. Cheap (a dozen entries) and the
    // only way a conflict copy of a shared root file gets noticed at all.
    function scanRootArtefacts() {
        return requireGrantedRoot().then(function (root) {
            var found = [];
            var it = root.values();
            function step() {
                return it.next().then(function (res) {
                    if (res.done) { _lastRootArtefacts = found; return found; }
                    var e = res.value;
                    if (e.kind === 'file' && isSyncArtefact(e.name)) found.push(e.name);
                    return step();
                });
            }
            return step();
        }).catch(function () { _lastRootArtefacts = []; return []; });
    }

    function readCard(id) {
        return IO.readJSON(cardPath(id));
    }

    // Every card on disk, deleted ones filtered out unless asked for.
    function readCards(includeDeleted) {
        return listCardIds().then(function (ids) {
            return Promise.all(ids.map(function (id) {
                return readCard(id).then(function (c) {
                    if (!c) return null;
                    if (!c.id) { c.id = id; return c; }   // heal a hand-copied file
                    // A card file is named after the id inside it. When it is not,
                    // this is not that card — it is a copy of it. SharePoint names
                    // conflict copies after the PERSON ("p_x-Elisa.json"), which no
                    // machine-name pattern can catch, and the copy keeps the
                    // original id. Loading it gave two cards with one id: the
                    // snapshot could match only one, so the other looked changed on
                    // every save, was written to the shared id on every save, and
                    // dragged every unrelated edit into a conflict on that card.
                    if (c.id !== id) { _lastArtefacts.push(id + '.json'); return null; }
                    return c;
                }).catch(function () { return null; });
            }));
        }).then(function (cards) {
            var byId = {}, kept = [];
            // Who deleted a card, and when, is evidence of activity that the
            // board's list never sees — capture it on the read that happens anyway.
            _lastDeletedStamps = cards.filter(function (c) { return c && c.deletedAt && c.updatedBy && c.updatedAt; })
                .map(function (c) { return { user: String(c.updatedBy), at: c.updatedAt }; });
            cards.forEach(function (c) {
                if (!c) return;
                if (!includeDeleted && c.deletedAt) return;
                var prev = byId[c.id];
                if (!prev) { byId[c.id] = c; kept.push(c); return; }
                // Belt and braces: two files claiming one id must never both reach
                // the board, whatever produced them. Keep the newer and report the
                // other, rather than letting two payloads fight over one file.
                _lastArtefacts.push(c.id + '.json (duplicate id)');
                var prevAt = Date.parse(prev.updatedAt || 0) || 0;
                var thisAt = Date.parse(c.updatedAt || 0) || 0;
                if (thisAt > prevAt || (thisAt === prevAt && Number(c.rev || 0) > Number(prev.rev || 0))) {
                    kept[kept.indexOf(prev)] = c;
                    byId[c.id] = c;
                }
            });
            return kept;
        });
    }

    function conflictError(id, theirs) {
        var e = new Error('Card ' + id + ' was changed by ' +
            ((theirs && theirs.updatedBy) || 'someone else') + ' while you were editing it');
        e.code = 'CONFLICT';
        e.cardId = id;
        e.theirs = theirs;
        return e;
    }

    // Write one card under optimistic concurrency.
    //   opts.baseRev  the rev this edit started from (default: card.rev)
    //   opts.force    write anyway, keeping the higher rev (user chose "mine")
    // Rejects with code 'CONFLICT' when the copy on disk moved on.
    function writeCard(card, opts) {
        opts = opts || {};
        if (!card || !card.id) return Promise.reject(new Error('Card needs an id'));
        var baseRev = (opts.baseRev != null) ? Number(opts.baseRev) : Number(card.rev || 0);
        return readCard(card.id).then(function (onDisk) {
            var diskRev = onDisk ? Number(onDisk.rev || 0) : 0;
            if (onDisk && diskRev !== baseRev && !opts.force) throw conflictError(card.id, onDisk);
            var next = {};
            Object.keys(card).forEach(function (k) { next[k] = card[k]; });
            next.rev = Math.max(diskRev, baseRev) + 1;
            next.updatedAt = new Date().toISOString();
            next.updatedBy = getUserLabel() || next.updatedBy || '';
            return IO.writeJSON(cardPath(card.id), next).then(function () { return next; });
        });
    }

    // A product merged into another (the dashboard's pipeline merge): the cards
    // that pointed at the product that goes away point at the one that stays.
    // Each card is written against its own rev; one someone else just moved is
    // read again and retried once. Resolves with the number of cards relinked.
    function relinkProductCards(fromId, toId, toName) {
        if (!fromId || !toId || fromId === toId) return Promise.resolve(0);
        var relabel = function (c) { c.productId = toId; if (toName) c.product = toName; };
        return dbMode().then(function (mode) {
            if (mode === 'legacy') {
                return readManifest().then(function (m) {
                    var n = 0;
                    (m.projects || []).forEach(function (c) { if (c && c.productId === fromId) { relabel(c); n++; } });
                    return n ? writeManifest(m).then(function () { return n; }) : 0;
                });
            }
            return readCards(true).then(function (cards) {
                var n = 0;
                return cards.filter(function (c) { return c && c.productId === fromId; }).reduce(function (chain, c) {
                    return chain.then(function () {
                        var next = {};
                        Object.keys(c).forEach(function (k) { next[k] = c[k]; });
                        relabel(next);
                        return writeCard(next, { baseRev: c.rev }).then(function () { n++; }, function (err) {
                            if (!err || err.code !== 'CONFLICT') throw err;
                            return readCard(c.id).then(function (fresh) {
                                if (!fresh || fresh.productId !== fromId) return;
                                relabel(fresh);
                                return writeCard(fresh, { baseRev: fresh.rev }).then(function () { n++; });
                            });
                        });
                    });
                }, Promise.resolve()).then(function () { return n; });
            });
        });
    }

    // Cards are soft-deleted: the file stays with deletedAt set. On a shared
    // folder a hard delete is unrecoverable for everyone at once, and a card
    // that reappears from another user's stale write is worse than a tombstone.
    function softDeleteCard(id) {
        return readCard(id).then(function (c) {
            if (!c) return null;
            c.deletedAt = new Date().toISOString();
            return writeCard(c, { baseRev: c.rev, force: true });
        });
    }

    function restoreCard(id) {
        return readCard(id).then(function (c) {
            if (!c) return null;
            // Remove the key rather than nulling it, so a restored card is
            // indistinguishable from one that was never deleted.
            delete c.deletedAt;
            return writeCard(c, { baseRev: c.rev, force: true });
        });
    }

    // Tombstoned cards, newest first. The phase files under projects/<id>/ are
    // never touched by a delete, so a restored card comes back with its work.
    function readDeletedCards() {
        return readCards(true).then(function (cards) {
            return cards.filter(function (c) { return c && c.deletedAt; })
                .sort(function (a, b) { return String(b.deletedAt).localeCompare(String(a.deletedAt)); });
        });
    }

    // Really remove a card file plus its phase folder. Only for cleanup by hand.
    function purgeCard(id) {
        return IO.remove(cardPath(id)).then(function () {
            return deleteProjectFiles(id);
        });
    }

    // ---- people -------------------------------------------------------------
    function emptyPeople() {
        return { schemaVersion: DB_SCHEMA, rev: 0, commercials: [], productManagers: [] };
    }

    function readPeople() {
        return IO.readJSON([PEOPLE_FILE]).then(function (p) {
            if (!p) return emptyPeople();
            p.commercials = p.commercials || [];
            p.productManagers = p.productManagers || [];
            p.rev = Number(p.rev || 0);
            return p;
        });
    }

    // The one genuinely shared file. On a conflict we do NOT overwrite: adding a
    // person is an addition, not a replacement, so both sides are merged by name
    // and the loser's entry survives.
    function writePeople(people, baseRev) {
        var base = (baseRev != null) ? Number(baseRev) : Number((people && people.rev) || 0);
        return readPeople().then(function (onDisk) {
            var merged;
            if (Number(onDisk.rev || 0) !== base) {
                merged = mergePeople(onDisk, people);
            } else {
                merged = {
                    schemaVersion: DB_SCHEMA,
                    commercials: (people && people.commercials) || [],
                    productManagers: (people && people.productManagers) || []
                };
            }
            merged.rev = Number(onDisk.rev || 0) + 1;
            merged.updatedAt = new Date().toISOString();
            merged.updatedBy = getUserLabel() || '';
            return IO.writeJSON([PEOPLE_FILE], merged).then(function () { return merged; });
        });
    }

    function mergePeople(theirs, mine) {
        function mergeList(a, b) {
            var byName = {};
            (a || []).forEach(function (p) { if (p && p.name) byName[p.name] = p; });
            // Ours wins on the fields, theirs supplies anyone we never saw.
            (b || []).forEach(function (p) {
                if (!p || !p.name) return;
                var prev = byName[p.name] || {};
                byName[p.name] = {
                    name: p.name,
                    email: p.email || prev.email || '',
                    phone: p.phone || prev.phone || ''
                };
            });
            return Object.keys(byName).sort().map(function (k) { return byName[k]; });
        }
        return {
            schemaVersion: DB_SCHEMA,
            commercials: mergeList(theirs && theirs.commercials, mine && mine.commercials),
            productManagers: mergeList(theirs && theirs.productManagers, mine && mine.productManagers),
            mergedFromRev: Number((theirs && theirs.rev) || 0)
        };
    }

    // ---- films: the material register -----------------------------------------
    // PerfoTec's own films (BOPE, Liner, Pallet Cover) and the films they are
    // tested against, kept once for every product in films.json at the root.
    // A trial row points at a film by id (pack_opt_<i>_film); the TV advisor
    // reads a film's CO₂ : O₂ behaviour, the client overview its name, polymer,
    // thickness and TDS. Films are archived, never deleted: old trials keep
    // pointing at them.
    var FILMS_FILE = 'films.json';
    var FILM_POLYMERS = ['BOPE', 'BOPP', 'PE', 'PP', 'PET', 'PLA', 'Other'];
    var FILM_FORMATS = ['Flowpack film', 'Lidding film', 'Bag', 'Liner', 'Pallet cover', 'Other'];
    var FILM_PACK_TYPES = ['Punnet', 'Flowpack', 'Crate/Box', 'Pallet'];
    function normFilm(f) {
        var s = function (v) { return v == null ? '' : String(v).trim(); };
        var x = f || {};
        return {
            id: s(x.id), name: s(x.name), own: !!x.own,
            polymer: s(x.polymer), thicknessUm: s(x.thicknessUm), format: s(x.format),
            packTypes: (Array.isArray(x.packTypes) ? x.packTypes : []).map(s).filter(function (t) { return FILM_PACK_TYPES.indexOf(t) >= 0; }),
            otr: s(x.otr), co2tr: s(x.co2tr), wvtr: s(x.wvtr),
            // The Hub film this is ('' = a film the Hub does not have): the Hub then
            // leads its name, thickness, OTR and CO2TR.
            hubId: s(x.hubId),
            tdsUrl: s(x.tdsUrl), aliases: s(x.aliases), notes: s(x.notes),
            archived: !!x.archived,
            createdAt: s(x.createdAt), updatedAt: s(x.updatedAt), updatedBy: s(x.updatedBy)
        };
    }
    function newFilmId() {
        return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    function readFilms() {
        return IO.readJSON([FILMS_FILE]).then(function (r) {
            var films = (r && Array.isArray(r.films) ? r.films : []).map(normFilm).filter(function (f) { return f.id && f.name; });
            return { schemaVersion: DB_SCHEMA, rev: Number((r && r.rev) || 0), films: films };
        });
    }
    // Writes the register. Someone else saved meanwhile (rev moved on): the two
    // are merged per film, the newer edit of each film winning, so neither side
    // loses a film or an edit.
    function writeFilms(reg, baseRev) {
        var base = (baseRev != null) ? Number(baseRev) : Number((reg && reg.rev) || 0);
        var mine = ((reg && reg.films) || []).map(normFilm).filter(function (f) { return f.id && f.name; });
        return readFilms().then(function (onDisk) {
            var films = Number(onDisk.rev || 0) === base ? mine : mergeFilms(onDisk.films, mine);
            var out = { schemaVersion: DB_SCHEMA, rev: Number(onDisk.rev || 0) + 1, updatedAt: new Date().toISOString(), updatedBy: getUserLabel() || '', films: films };
            return IO.writeJSON([FILMS_FILE], out).then(function () { return out; });
        });
    }
    function mergeFilms(theirs, mine) {
        var byId = {}, order = [];
        (theirs || []).concat(mine || []).forEach(function (f) {
            if (!f || !f.id) return;
            var prev = byId[f.id];
            if (!prev) order.push(f.id);
            if (!prev || String(f.updatedAt || '') >= String(prev.updatedAt || '')) byId[f.id] = f;
        });
        return order.map(function (id) { return byId[id]; });
    }
    // ---- The team's work lists -----------------------------------------------
    // What the dashboard's overview asks the team to do next (Luke 2026-11-16):
    //   * trials that are running — on the board, not finished, so nobody
    //     starts the same test twice and sales can see what is coming;
    //   * results that rest on a single round — each can become a proposal for
    //     a verification round with the winning settings filled in;
    //   * trial data that is incomplete — what is missing per product and per
    //     report, and patches that fill a field for many rows at once.
    // All of it is read here; the dashboard decides what to write.

    // A trial that is under way: on the board, not deleted, stopped or
    // archived, and not yet in Dashboard (its results are in the product then).
    var RUNNING_PHASES = { intake: true, proposal: true, accepted: true, report: true };
    function isRunningTrial(card) {
        return !!card && !card.deletedAt && !card.haltedAt && !card.archivedAt && RUNNING_PHASES[card.phase] === true;
    }
    // { byProduct: { productId: [card] }, unlinked: [card], all: [card] }, each
    // list newest start first. A card whose product no longer exists is unlinked.
    function runningTrials(cards, productIds) {
        var known = null;
        if (Array.isArray(productIds)) { known = {}; productIds.forEach(function (id) { known[id] = true; }); }
        var when = function (c) { return String(c.startDate || c.updatedAt || ''); };
        var all = (cards || []).filter(isRunningTrial).sort(function (a, b) { return when(b).localeCompare(when(a)); });
        var out = { byProduct: {}, unlinked: [], all: all };
        all.forEach(function (c) {
            if (c.productId && (!known || known[c.productId])) (out.byProduct[c.productId] = out.byProduct[c.productId] || []).push(c);
            else out.unlinked.push(c);
        });
        return out;
    }

    // The proposal's packaging names for the dashboard's packaging types
    // (reportPackType reads them back the same way).
    var PROPOSAL_PACKAGING = { 'Punnet': 'Punnets', 'Flowpack': 'Pillow Bag', 'Crate/Box': 'Box/ Crate', 'Pallet': 'Pallet' };
    // A proposal for a verification round of one result: the same product,
    // variety, packaging, pack weight and temperature, the winning variant with
    // its film, transmission, perforation and gas at packing, next to the
    // current packaging of that round. A new report at the same settings is a
    // second round, which is what makes a result proven (trialBestPractice).
    // The text names the days and the temperature, never the transmission or
    // the respiration: a proposal goes to the client.
    //   group: one group of trialBestPractice (its winner is repeated)
    //   opts: { films, rows (all trialRows, to find the round's reference), user, language, now, id }
    // { card, doc } — nothing is written here.
    function verificationProposal(product, group, opts) {
        var o = opts || {}, w = group && group.winner;
        if (!product || !product.id || !w || !w.shelfLife) return null;
        var filmOf = function (id) { return (o.films || []).filter(function (f) { return f.id === id; })[0] || null; };
        var type = normPackType(w.type);
        var packaging = PROPOSAL_PACKAGING[type] || 'Box/ Crate';
        var variety = w.variety || product.variety || '';
        var label = [product.name, variety].filter(Boolean).join(' ');
        var days = w.shelfLife.days;
        var now = o.now || new Date().toISOString();
        var title = 'Verification round — ' + label + ' · ' + type + (w.temp != null ? ' · ' + w.temp + ' °C' : '');
        var dayList = [0, Math.max(1, Math.round(days / 2)), days, days + Math.max(2, Math.round(days * 0.25))]
            .filter(function (d, i, a) { return a.indexOf(d) === i; }).sort(function (a, b) { return a - b; });
        var measurements = function () { return dayList.map(function (d) { return { day: d, measure: [], open: [], evaluate: [] }; }); };
        var specsOf = function (r, role) {
            var film = filmOf(r.film);
            var tv = plausibleTv(r.trans);
            var specs = { packaging: packaging, material: film ? film.name : (r.filmSpec || ''), filmThickness: film ? film.thicknessUm : '', length: '', width: '', height: '',
                holes: tv != null ? String(tv) : '', startWeight: r.weight || '', sampleCount: 3, role: role,
                atmosphereStrategy: r.condition === 'OPEN' ? 'Open' : r.condition === 'MHP' ? 'MHP' : 'MAP' };
            if (r.film) specs.filmId = r.film;
            if (r.perf) specs.perforation = r.perf;
            if (r.flush) specs.gasFlush = r.flush;
            if (r.startO2 || r.startCO2) specs.startGas = { o2: r.startO2 || '', co2: r.startCO2 || '' };
            if (r.hubPackage) specs.hubPackage = r.hubPackage;
            if (r.laserProgram) specs.laserProgram = r.laserProgram;
            return specs;
        };
        var groups = [];
        var reference = w.role === 'reference' ? null : (o.rows || []).filter(function (r) { return r.role === 'reference' && r.round === w.round && normPackType(r.type) === type; })[0] || null;
        if (w.role !== 'reference') {
            groups.push(reference
                ? { id: 1, name: reference.material || 'Control', specs: specsOf(reference, 'reference'), measurements: measurements(), predictedImage: null }
                : { id: 1, name: 'Control', specs: { packaging: packaging, material: '', length: '', width: '', height: '', holes: '', startWeight: w.weight || '', sampleCount: 3, role: 'reference' }, measurements: measurements(), predictedImage: null });
        }
        groups.push({ id: groups.length + 1, name: w.material || 'PerfoTec', specs: specsOf(w, w.role === 'reference' ? 'reference' : 'perfotec'), measurements: measurements(), predictedImage: null });
        var winnerFilm = filmOf(w.film);
        var doc = {
            isPerfoTecProposal: true, schemaVersion: '2.1', exportDate: now, language: o.language || 'en',
            project: {
                reportTitle: title, productName: product.name || '', productId: product.id,
                processingType: String(product.state || '').toLowerCase() === 'processed' ? 'Processed' : 'Whole', type: variety,
                startWeight: w.weight || '',
                trialTarget: 'Verify the earlier result' + (w.date ? ' of ' + w.date : '') + ': quality within specification for ' + (w.shelfLife.open ? 'at least ' : '') + days + ' day' + (days === 1 ? '' : 's')
                    + (w.temp != null ? ' at ' + w.temp + ' °C' : '') + ', in the same packaging and pack weight, against the current packaging.',
                packagings: [{ id: 1, packagingType: packaging, material: winnerFilm ? winnerFilm.name : (w.filmSpec || ''), length: '', width: '', height: '', startWeight: w.weight || '' }],
                // What this round verifies: the dashboard result it repeats.
                verificationOf: { productId: product.id, group: group.key || '', round: w.round || '', date: w.date || '', days: days, open: !!w.shelfLife.open }
            },
            groups: groups
        };
        if (w.temp != null) doc.supplyChain = [{ stage: 'Storage', tempStart: String(w.temp), tempEnd: '', daysStart: String(dayList[dayList.length - 1]), daysEnd: '', action: 'pack' }];
        var card = { id: o.id || newId(), title: title, client: '', product: label, productId: product.id, commercial: '', productManager: o.user || '', startDate: '',
            actions: [], phase: 'proposal', image: '', files: { proposal: true }, updatedAt: now };
        return { card: card, doc: doc };
    }

    // What a product's trial table lacks. Per row: no film from the register,
    // no transmission (or a number that is a perforation count), no variety,
    // no temperature, no date, no quality curve (nothing to read a shelf life
    // from), and no packing details (perforation, flush or gas at packing).
    // { rows, checks, missing: { film, tv, tvNotATv, variety, temperature, date, curve, packing },
    //   core (the sum without packing), reports: [{ key, date, pdf, idxs, perfotec, missing }] }
    // A report is the rows of one report name and date (else one board
    // project, else the rows without either), newest first.
    function trialDataGaps(master, productNames, films) {
        var m = master || {};
        var rows = trialRows(m);
        var keys = ['film', 'tv', 'tvNotATv', 'variety', 'temperature', 'date', 'curve', 'packing'];
        var blank = function () { var o = {}; keys.forEach(function (k) { o[k] = 0; }); return o; };
        var total = blank(), byReport = {}, order = [];
        rows.forEach(function (r) {
            var f = function (k) { var v = m['pack_opt_' + r.i + '_' + k]; return v == null ? '' : String(v).trim(); };
            var key = (f('pdf') || f('date')) ? 'r|' + f('pdf').toLowerCase() + '|' + f('date') : f('project') ? 'p|' + f('project') : '';
            if (!byReport[key]) { byReport[key] = { key: key, date: '', pdf: f('pdf'), idxs: [], perfotec: [], missing: blank() }; order.push(key); }
            var g = byReport[key];
            g.idxs.push(r.i);
            if (r.role !== 'reference') g.perfotec.push(r.i);
            if (f('date') > g.date) g.date = f('date');
            var miss = {
                film: !f('film'), tv: !f('trans'), tvNotATv: !!f('trans') && plausibleTv(f('trans')) == null, variety: !f('variety'),
                temperature: !f('temp'), date: !f('date'), curve: r.curve.length < 2,
                packing: !f('perf') && !f('flush') && !f('startO2') && !f('startCO2')
            };
            keys.forEach(function (k) { if (miss[k]) { total[k]++; g.missing[k]++; } });
        });
        var checks = [];
        try { checks = trialDataChecks(m, productNames || [], films || null); } catch (e) { checks = []; }
        var reports = order.map(function (k) { return byReport[k]; }).sort(function (a, b) { return a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.idxs[0] - b.idxs[0]; });
        // The packing details are new, and the variety is not needed to compare or
        // verify a result: neither counts towards the gaps that matter.
        var core = keys.filter(function (k) { return k !== 'packing' && k !== 'variety'; }).reduce(function (n, k) { return n + total[k]; }, 0);
        return { rows: rows.length, checks: checks, missing: total, core: core, reports: reports };
    }
    // A patch that gives rows a value where they have none: { film, perf, flush }
    // (any of them), for the given rows — all of them, or with opts.perfotecOnly
    // the rows that are not the reference (a report's control is packed in
    // another film). Never overwrites. { patch, filled }
    function fillTrialFields(master, idxs, values, opts) {
        var m = master || {}, v = values || {}, patch = {}, filled = 0;
        (idxs || []).forEach(function (i) {
            if (opts && opts.perfotecOnly && trialRowRole(m, i) === 'reference') return;
            ['film', 'perf', 'flush'].forEach(function (k) {
                var want = v[k] == null ? '' : String(v[k]).trim();
                if (!want || String(m['pack_opt_' + i + '_' + k] == null ? '' : m['pack_opt_' + i + '_' + k]).trim() !== '') return;
                patch['pack_opt_' + i + '_' + k] = want; filled++;
            });
        });
        return { patch: patch, filled: filled };
    }
    // The data check's proposals that carry a value (a variety read from the
    // report title, a packaging type from the variant's name, a film from the
    // register), as one patch. A transmission that looks like a perforation
    // count has no proposal — the real value has to be typed — and stays open.
    // { patch, accepted, open }
    function acceptDataChecks(master, productNames, films) {
        var checks = [];
        try { checks = trialDataChecks(master || {}, productNames || [], films || null); } catch (e) { checks = []; }
        var patch = {}, accepted = 0, open = 0;
        checks.forEach(function (c) {
            var value = String(c.proposed == null ? '' : c.proposed).trim();
            if (!value || c.field === 'trans') { open++; return; }
            patch['pack_opt_' + c.i + '_' + c.field] = value; accepted++;
        });
        return { patch: patch, accepted: accepted, open: open };
    }

    // ---- PerfoTec Hub: catalogue snapshot and links ---------------------------
    // The Hub (the machine platform) keeps its own catalogue: product groups
    // with their varieties (respiration, target atmosphere), films (OTR, COTR),
    // packages (film, sizes, mass, volume) and laser programs. A snapshot of it
    // — exported from the Hub as one "perfotec-hub-catalogue/1" object, the
    // shape an API would return — is kept in hub.json at the root, with the
    // links between the two sides: dashboard product -> Hub product group, and
    // register film -> Hub film. A link is a Hub id ('' = deliberately none);
    // no link stored means "match on name". Trial rows point at a Hub package
    // and a laser program themselves (pack_opt_i_hubPackage / _laserProgram).
    // Nothing here writes to the Hub.
    var HUB_FILE = 'hub.json';
    var HUB_FORMAT = 'perfotec-hub-catalogue/1';
    function normHubCatalogue(c) {
        var x = c || {};
        var s = function (v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); };
        var n = function (v) { var f = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(f) ? f : null; };
        var list = function (a, fn) { return (Array.isArray(a) ? a : []).map(fn).filter(function (r) { return r.id && r.name; }); };
        return {
            format: HUB_FORMAT, source: s(x.source), exportedAt: s(x.exportedAt),
            products: list(x.products, function (p) { return { id: s(p.id), name: s(p.name) }; }),
            varieties: list(x.varieties, function (v) {
                return { id: s(v.id), productId: s(v.productId), name: s(v.name), state: hubStateWord(s(v.state) || s(v.productState) || s(v.processingType)), density: n(v.density), targetO2: n(v.targetO2), criticalCO2: n(v.criticalCO2),
                    temperature: n(v.temperature), rrO2: n(v.rrO2), rrCO2: n(v.rrCO2), rrTemp: n(v.rrTemp), productFactor: n(v.productFactor), rrCount: n(v.rrCount) };
            }),
            films: list(x.films, function (f) {
                return { id: s(f.id), name: s(f.name), thicknessUm: n(f.thicknessUm), otr: n(f.otr), otrTemp: n(f.otrTemp), otrRh: n(f.otrRh), cotr: n(f.cotr), cotrTemp: n(f.cotrTemp), cotrRh: n(f.cotrRh) };
            }),
            packages: list(x.packages, function (p) {
                return { id: s(p.id), name: s(p.name), filmId: s(p.filmId), type: s(p.type), length: n(p.length), width: n(p.width), area: n(p.area), mass: n(p.mass), volume: n(p.volume) };
            }),
            laserPrograms: list(x.laserPrograms, function (p) {
                return { id: s(p.id), name: s(p.name), product: s(p.product), variety: s(p.variety), holes: n(p.holes), size: n(p.size), status: s(p.status) };
            }),
            // The respiration measurements (FRM) behind the varieties: what was
            // really measured, with where the product came from and when.
            // status 'OK' or 'NOK' (the Hub's "doubtful"). Kept only with a rate
            // and a temperature.
            respirations: (Array.isArray(x.respirations) ? x.respirations : []).map(function (r) {
                return { id: s(r.id), varietyId: s(r.varietyId), product: s(r.product), variety: s(r.variety), remark: s(r.remark), origin: s(r.origin),
                    startTime: s(r.startTime), rrO2: n(r.rrO2), rrCO2: n(r.rrCO2), temperature: n(r.temperature), status: s(r.status).toUpperCase() === 'NOK' ? 'NOK' : 'OK', meter: s(r.meter) };
            }).filter(function (r) { return r.id && r.temperature != null && (r.rrO2 != null || r.rrCO2 != null); })
        };
    }
    // 'whole' | 'processed' | '' from what the Hub says about a variety.
    function hubStateWord(v) {
        var t = String(v == null ? '' : v).toLowerCase();
        return /process|cut|slic|dice|shred|peel/.test(t) ? 'processed' : /whole|intact|uncut/.test(t) ? 'whole' : '';
    }
    var HUB_LINK_KINDS = ['products', 'films', 'varieties'];
    function normHubLinks(l) {
        var out = { products: {}, films: {}, varieties: {} };
        HUB_LINK_KINDS.forEach(function (k) {
            var src = (l && l[k]) || {};
            Object.keys(src).forEach(function (id) { if (id) out[k][id] = src[id] == null ? '' : String(src[id]); });
        });
        return out;
    }
    function readHub() {
        return IO.readJSON([HUB_FILE]).then(function (r) {
            return { schemaVersion: DB_SCHEMA, rev: Number((r && r.rev) || 0), catalogue: r && r.catalogue ? normHubCatalogue(r.catalogue) : null,
                links: normHubLinks(r && r.links), importedAt: String((r && r.importedAt) || ''), importedBy: String((r && r.importedBy) || '') };
        });
    }
    // patch: { catalogue } (a new snapshot replaces the old one) and/or
    // { links: { products: {id: hubId}, films: {id: hubId} } } (merged into
    // what is on disk, so two people linking at once both keep their links).
    function writeHub(patch) {
        var p = patch || {};
        return readHub().then(function (onDisk) {
            var links = normHubLinks(onDisk.links), add = p.links || {};
            // A link set to null is taken away again: back to matching on name.
            HUB_LINK_KINDS.forEach(function (k) {
                Object.keys(add[k] || {}).forEach(function (id) { if (!id) return; if (add[k][id] == null) delete links[k][id]; else links[k][id] = String(add[k][id]); });
            });
            var fresh = !!p.catalogue;
            var out = { schemaVersion: DB_SCHEMA, rev: onDisk.rev + 1, catalogue: fresh ? normHubCatalogue(p.catalogue) : onDisk.catalogue, links: links,
                importedAt: fresh ? new Date().toISOString() : onDisk.importedAt, importedBy: fresh ? (getUserLabel() || '') : onDisk.importedBy };
            return IO.writeJSON([HUB_FILE], out).then(function () { return out; });
        });
    }
    // A name as it is compared: lower case, plurals folded ("Cherries" =
    // "Cherry", "Potatoes" = "Potato"), punctuation gone.
    function hubNameKey(name) {
        return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
            .split(' ').map(function (w) { return w.length > 3 ? w.replace(/ies$/, 'y').replace(/oes$/, 'o').replace(/s$/, '') : w; }).join(' ');
    }
    // The Hub product group of a dashboard product: the stored link, else its
    // own name or one of its other names, exactly (after hubNameKey); else the
    // one group whose name is a whole part of it ("Iceberg Lettuce" -> "Iceberg").
    // { hub, how: 'linked' | 'name' | 'part' | 'none' | 'unlinked' }
    function hubProductOf(product, hub) {
        var cat = hub && hub.catalogue;
        if (!cat || !product) return { hub: null, how: 'none' };
        var link = hub.links && hub.links.products ? hub.links.products[product.id] : undefined;
        if (link === '') return { hub: null, how: 'unlinked' };
        if (link) { var linked = cat.products.filter(function (p) { return p.id === link; })[0]; if (linked) return { hub: linked, how: 'linked' }; }
        var names = [product.name].concat(Array.isArray(product.aliases) ? product.aliases : []).map(hubNameKey).filter(Boolean);
        var exact = cat.products.filter(function (p) { return names.indexOf(hubNameKey(p.name)) >= 0; });
        if (exact.length === 1) return { hub: exact[0], how: 'name' };
        var part = cat.products.filter(function (p) {
            var k = ' ' + hubNameKey(p.name) + ' ';
            return k.trim() && names.some(function (nm) { return (' ' + nm + ' ').indexOf(k) >= 0; });
        });
        return part.length === 1 ? { hub: part[0], how: 'part' } : { hub: null, how: 'none' };
    }
    // Whole or processed, for a Hub variety: what the Hub records, else what
    // its name (or its product group's) says — "Fresh cut", "Sliced", "Arils",
    // "Florets" — else whole, which is what a variety is until it is cut.
    // { state: 'whole' | 'processed', from: 'hub' | 'name' | 'assumed' }
    var HUB_PROCESSED_WORDS = /(^| )(cut|fresh cut|freshcut|sliced|slices|diced|shredded|processed|peeled|floret|florets|aril|arils|wedges|chunks|sticks|cubes|rings|grated|chopped)( |$)/;
    function hubVarietyState(variety, hubProduct) {
        if (variety && variety.state) return { state: variety.state, from: 'hub' };
        var text = String((variety && variety.name) || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' ' + String((hubProduct && hubProduct.name) || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
        return HUB_PROCESSED_WORDS.test(text.replace(/\s+/g, ' ').trim()) ? { state: 'processed', from: 'name' } : { state: 'whole', from: 'assumed' };
    }
    // The Hub varieties that ARE a dashboard product (Luke 2026-11-13): the
    // product is found by name (hubProductOf), then
    //   * whole against whole, processed against processed — never mixed;
    //   * a product record of one variety takes the Hub varieties of that
    //     name only (none when the Hub has no such variety: another
    //     variety's respiration is not this one's);
    //   * a record without a variety takes every variety of its state.
    // A stored choice wins: links.varieties[product.id] = a Hub variety id,
    // or '*' for all varieties of the Hub product whatever their name.
    // { hub, how, varieties, rule: 'chosen' | 'all' | 'variety' | 'state' | 'none', missing }
    function hubVarietiesOf(product, hub) {
        var cat = hub && hub.catalogue;
        var m = hubProductOf(product, hub);
        if (!cat || !m.hub) return { hub: null, how: m.how, varieties: [], rule: 'none', missing: '' };
        var all = cat.varieties.filter(function (v) { return v.productId === m.hub.id; });
        var choice = hub.links && hub.links.varieties ? hub.links.varieties[product.id] : undefined;
        if (choice === '*') return { hub: m.hub, how: m.how, varieties: all, rule: 'all', missing: '' };
        if (choice) { var one = all.filter(function (v) { return v.id === choice; }); if (one.length) return { hub: m.hub, how: m.how, varieties: one, rule: 'chosen', missing: '' }; }
        var want = String(product.state || 'whole').toLowerCase() === 'processed' ? 'processed' : 'whole';
        var ofState = all.filter(function (v) { return hubVarietyState(v, m.hub).state === want; });
        var variety = hubNameKey(product.variety);
        if (!variety) return { hub: m.hub, how: m.how, varieties: ofState, rule: ofState.length ? 'state' : 'none', missing: ofState.length ? '' : 'no ' + want + ' variety in the Hub' };
        var named = ofState.filter(function (v) { var k = hubNameKey(v.name); return k === variety || (' ' + k + ' ').indexOf(' ' + variety + ' ') >= 0 || (' ' + variety + ' ').indexOf(' ' + k + ' ') >= 0; });
        return { hub: m.hub, how: m.how, varieties: named, rule: named.length ? 'variety' : 'none', missing: named.length ? '' : 'no ' + want + ' variety named ' + product.variety + ' in the Hub' };
    }
    // The Hub's respiration measurements of a dashboard product: those of its
    // Hub varieties (hubVarietiesOf). [] without a link or a snapshot.
    function hubRespirationsOf(product, hub) {
        var cat = hub && hub.catalogue;
        var v = hubVarietiesOf(product, hub);
        if (!cat || !v.varieties.length) return [];
        var ids = {};
        v.varieties.forEach(function (x) { ids[x.id] = true; });
        return (cat.respirations || []).filter(function (r) { return !!ids[r.varietyId]; });
    }
    // The measurements as a product record keeps them (formData['hub-respiration']):
    // the numbers the curve needs and where each one came from.
    function hubRespirationRecord(product, hub) {
        var v = hubVarietiesOf(product, hub);
        var rows = hubRespirationsOf(product, hub);
        if (!v.hub || !rows.length) return null;
        return { hubProductId: v.hub.id, hubProduct: v.hub.name, varietyIds: v.varieties.map(function (x) { return x.id; }),
            catalogueOf: String((hub.catalogue && hub.catalogue.exportedAt) || ''),
            measurements: rows.map(function (r) { return { id: r.id, varietyId: r.varietyId, variety: r.variety, origin: r.origin, remark: r.remark, startTime: r.startTime, temperature: r.temperature, rrO2: r.rrO2, rrCO2: r.rrCO2, status: r.status }; })
                .sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); }) };
    }
    // Per temperature the median of the measurements that count (status OK),
    // and whether they may drive the respiration curve: at least
    // HUB_RR_MIN_TEMPS different temperatures (a curve through fewer points is
    // a guess). { points: [{ t, rrO2, rrCO2, n }], drives }
    var HUB_RR_MIN_TEMPS = 3;
    function hubRespirationCurve(record) {
        var ok = ((record && record.measurements) || []).filter(function (r) { return r && r.status !== 'NOK' && isFinite(r.temperature); });
        var byT = {};
        ok.forEach(function (r) { (byT[r.temperature] = byT[r.temperature] || []).push(r); });
        var points = Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) {
            var g = byT[t];
            return { t: t, n: g.length, rrO2: medianOf(g.map(function (r) { return r.rrO2; }).filter(function (x) { return x > 0; })), rrCO2: medianOf(g.map(function (r) { return r.rrCO2; }).filter(function (x) { return x > 0; })) };
        });
        return { points: points, drives: points.filter(function (p) { return p.rrO2 != null || p.rrCO2 != null; }).length >= HUB_RR_MIN_TEMPS };
    }
    // The Hub manages the films (Luke 2026-11-13). The register follows it:
    // every Hub film is in the register, with the Hub's name, thickness, OTR
    // and CO2TR; what only the dashboard knows — WVTR, PerfoTec's own film or
    // not, polymer, packaging, data sheet, notes, archived — stays as it is.
    // A register film the Hub does not have is left alone. An older name is
    // kept as an alias, so trial rows that say it still find the film.
    // { films, added, updated } — nothing is written here.
    function hubSyncFilms(films, hub, now) {
        var cat = hub && hub.catalogue;
        var list = (films || []).map(normFilm);
        if (!cat) return { films: list, added: 0, updated: 0 };
        var stamp = now || new Date().toISOString(), added = 0, updated = 0;
        var txt = function (v) { return v == null ? '' : String(v); };
        cat.films.forEach(function (h) {
            var mine = list.filter(function (f) { return f.hubId === h.id; })[0]
                || list.filter(function (f) { return !f.hubId && (hubFilmOf(f, hub).hub || {}).id === h.id; })[0];
            var lead = { hubId: h.id, name: h.name, thicknessUm: txt(h.thicknessUm), otr: txt(h.otr), co2tr: txt(h.cotr) };
            if (!mine) { list.push(normFilm({ id: 'hub_' + h.id, hubId: h.id, name: h.name, thicknessUm: lead.thicknessUm, otr: lead.otr, co2tr: lead.co2tr, createdAt: stamp, updatedAt: stamp, updatedBy: 'PerfoTec Hub' })); added++; return; }
            var changed = false;
            if (mine.name !== h.name) {
                var aliases = mine.aliases.split(/[,;\n]/).map(function (a) { return a.trim(); }).filter(Boolean);
                if (mine.name && aliases.map(function (a) { return a.toLowerCase(); }).indexOf(mine.name.toLowerCase()) < 0) aliases.push(mine.name);
                mine.aliases = aliases.join('; ');
            }
            Object.keys(lead).forEach(function (k) { if (k !== 'hubId' && k !== 'name' && lead[k] === '') return; if (mine[k] !== lead[k]) { mine[k] = lead[k]; changed = true; } });
            if (changed) { mine.updatedAt = stamp; mine.updatedBy = 'PerfoTec Hub'; updated++; }
        });
        return { films: list, added: added, updated: updated };
    }
    // The Hub film of a register film: the stored link, else the one Hub film
    // with the same name or alias. Films are not matched on a part of the name:
    // "BOPP 30" and "BOPP 30 antifog" are different films.
    function hubFilmOf(film, hub) {
        var cat = hub && hub.catalogue;
        if (!cat || !film) return { hub: null, how: 'none' };
        var link = hub.links && hub.links.films ? hub.links.films[film.id] : undefined;
        if (link === undefined && film.hubId) link = film.hubId;
        if (link === '') return { hub: null, how: 'unlinked' };
        if (link) { var linked = cat.films.filter(function (f) { return f.id === link; })[0]; if (linked) return { hub: linked, how: 'linked' }; }
        var names = [film.name].concat(String(film.aliases || '').split(/[,;\n]/)).map(hubNameKey).filter(Boolean);
        var exact = cat.films.filter(function (f) { return names.indexOf(hubNameKey(f.name)) >= 0; });
        return exact.length === 1 ? { hub: exact[0], how: 'name' } : { hub: null, how: 'none' };
    }

    // "PerfoTec BOPE · 30 µm" — how a film is named in lists.
    function filmLabel(film) {
        if (!film) return '';
        var bits = [film.name];
        if (film.polymer && film.name.toLowerCase().indexOf(film.polymer.toLowerCase()) < 0) bits.push(film.polymer);
        if (film.thicknessUm) bits.push(film.thicknessUm + ' µm');
        return bits.join(' · ');
    }
    // The ONE active film whose name or one of whose aliases occurs in `text`
    // as a whole word ("PerfoTec C+ bag" -> the film with alias "C+"). Several:
    // the thickness in the text decides; still several, or none -> null.
    function matchFilm(text, films) {
        var t = ' ' + String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ') + ' ';
        if (!t.trim()) return null;
        var hits = (films || []).filter(function (f) {
            if (!f || f.archived || !f.id) return false;
            var terms = [f.name].concat(String(f.aliases || '').split(/[,;]/)).map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(function (x) { return x.length >= 2; });
            // "standard pack (no C+ bag)" names the film only to say it is absent.
            return terms.some(function (term) {
                var re = new RegExp('(^|[^a-z0-9+])' + escapeRegExp(term) + '(?=$|[^a-z0-9+])', 'g'), hit;
                while ((hit = re.exec(t))) {
                    var before = t.slice(Math.max(0, hit.index - 12), hit.index + hit[1].length);
                    if (!/(^|[^a-z])(no|not|without|zonder|geen|sin)\s+$/.test(before)) return true;
                }
                return false;
            });
        });
        if (hits.length > 1) {
            var um = (t.match(/(\d+(?:[.,]\d+)?)\s*(?:µm|um|micron)/) || [])[1];
            if (um) hits = hits.filter(function (f) { return parseFloat(String(f.thicknessUm).replace(',', '.')) === parseFloat(um.replace(',', '.')); });
        }
        return hits.length === 1 ? hits[0] : null;
    }

    // ---- advisory lock ------------------------------------------------------
    // Informational only: the board shows "Anna is working on this". A hard lock
    // would strand work the moment someone closes their laptop with a card open.
    var LOCK_FILE = '.lock.json';
    var LOCK_STALE_MS = 2 * 60 * 1000;

    function touchLock(projectId) {
        return IO.writeJSON([PROJECTS_DIR, projectId, LOCK_FILE], {
            user: getUserLabel() || 'unknown',
            at: new Date().toISOString()
        }).catch(function () { /* a lock we cannot write is not worth failing over */ });
    }

    function readLock(projectId) {
        return IO.readJSON([PROJECTS_DIR, projectId, LOCK_FILE]).then(function (l) {
            if (!l || !l.at) return null;
            var age = Date.now() - new Date(l.at).getTime();
            if (!(age >= 0) || age > LOCK_STALE_MS) return null;
            if (l.user && l.user === getUserLabel()) return null;   // that's us
            return { user: l.user, at: l.at, ageMs: age };
        }).catch(function () { return null; });
    }

    function releaseLock(projectId) {
        return IO.remove([PROJECTS_DIR, projectId, LOCK_FILE]).catch(function () { /* best effort */ });
    }

    /* ---- presence -----------------------------------------------------------
     * Who else has this database open. The advisory lock above answers "is
     * someone in THIS card"; this answers "who is working in here at all", from
     * any of the tools, because every page loads this file.
     *
     * ONE SMALL FILE PER SESSION, never a shared one. Two people writing the
     * same file on a OneDrive/SharePoint folder is precisely what produces
     * conflict copies — the reason cards were split up in schema 2.0. Each
     * session only ever writes its own file, so there is nothing to collide.
     *
     * This is "recently active", NOT real time. A synced folder hands a write to
     * the other side when it gets round to it, which can be seconds or minutes.
     * The UI has to say so rather than imply a live user list.
     * ---------------------------------------------------------------------- */
    var PRESENCE_DIR = '.presence';
    var PRESENCE_BEAT_MS = 45 * 1000;
    var PRESENCE_STALE_MS = 150 * 1000;              // ~3 missed beats

    var _presenceTimer = null;
    var _sessionId = null;

    // Per TAB, and stable across navigation within it, so walking board -> report
    // -> board stays one presence rather than three. sessionStorage is the only
    // store with exactly that lifetime.
    function sessionId() {
        if (_sessionId) return _sessionId;
        var rnd = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        try {
            _sessionId = window.sessionStorage.getItem('perfotec_session_id');
            if (!_sessionId) { _sessionId = rnd; window.sessionStorage.setItem('perfotec_session_id', _sessionId); }
        } catch (e) { _sessionId = rnd; }
        return _sessionId;
    }

    function presencePage() {
        var here = decodeSeg((window.location.pathname || '').split('/').pop());
        return here || 'board.html';
    }

    function touchPresence() {
        var user = getUserLabel();
        // No name, no entry: an "unknown" in the list is noise, not information.
        if (!user) return Promise.resolve(false);
        return IO.writeJSON([PRESENCE_DIR, sessionId() + '.json'], {
            user: user, sessionId: sessionId(), page: presencePage(), at: new Date().toISOString()
        }).then(function () { return true; }).catch(function () { return false; });
    }

    // Everyone seen recently, ourselves included (the caller decides how to show
    // that). Never rejects: presence is a nicety and must not break a board load.
    function readPresence() {
        return IO.list([PRESENCE_DIR]).then(function (entries) {
            var files = entries.filter(function (e) { return e.kind === 'file' && /.json$/i.test(e.name); });
            return Promise.all(files.map(function (f) {
                return IO.readJSON([PRESENCE_DIR, f.name])
                    .then(function (rec) { return (rec && rec.at) ? { rec: rec, file: f.name } : null; })
                    .catch(function () { return null; });
            }));
        }).then(function (rows) {
            var now = Date.now();
            // ONE lasting record per person, not per session. Files are per session
            // (that is what keeps them collision-free on a synced folder), so a
            // colleague who has opened the board twenty times leaves twenty files.
            // Keep their newest and sweep the rest: what matters is "when was this
            // person last here", and that is never deleted.
            var newest = {}, superseded = [];
            rows.filter(Boolean).forEach(function (r) {
                var name = String(r.rec.user || '').trim() || 'unknown';
                var t = new Date(r.rec.at).getTime();
                if (!(t > 0)) return;                          // unreadable stamp, ignore
                var prev = newest[name];
                if (!prev) { newest[name] = { rec: r.rec, file: r.file, t: t }; return; }
                if (t > prev.t) { superseded.push(prev.file); newest[name] = { rec: r.rec, file: r.file, t: t }; }
                else superseded.push(r.file);
            });
            var me = String(getUserLabel() || '').trim();
            var entries = Object.keys(newest).map(function (name) {
                var b = newest[name];
                var age = now - b.t;
                if (!(age >= 0)) age = 0;                      // clock skew: treat as now
                return {
                    user: name, page: b.rec.page || '', at: b.rec.at,
                    ageMs: age, online: age <= PRESENCE_STALE_MS,
                    self: b.rec.sessionId === sessionId() || (!!me && name === me)
                };
            });
            // Only a person's SUPERSEDED files are swept. Their most recent record
            // is never removed, however old — that is the whole point. Nothing is
            // lost: a superseded file is by definition older than one we keep.
            superseded.forEach(function (f) { IO.remove([PRESENCE_DIR, f]).catch(function () { }); });
            entries.sort(function (a, b) {
                if (a.online !== b.online) return a.online ? -1 : 1;
                return a.user.localeCompare(b.user) || a.ageMs - b.ageMs;
            });
            return entries;
        }).catch(function () { return []; });
    }

    function releasePresence() {
        return IO.remove([PRESENCE_DIR, sessionId() + '.json']).catch(function () { /* best effort */ });
    }

    function startPresence() {
        if (_presenceTimer) return;
        var beat = function () {
            permissionState().then(function (state) {
                if (state !== 'granted') return;   // no folder bound yet, nothing to announce
                return touchPresence().then(function () { return touchSeen(); });
            }).catch(function () { /* never surface */ });
        };
        beat();
        _presenceTimer = setInterval(beat, PRESENCE_BEAT_MS);
        // Closing the tab deliberately does NOT delete the record. It is the only
        // trace that a colleague was ever in here: someone who is in no picklist
        // and has written no card vanished completely the moment they closed the
        // board. The record stays and becomes their "last seen"; PRESENCE_STALE_MS
        // is what turns it from online into offline, ~2.5 minutes later.
    }

    function stopPresence() {
        if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = null; }
        // Stop announcing, but keep the record: it is this person's last-seen.
        // releasePresence() stays exported for a deliberate "forget me".
        return Promise.resolve();
    }

    // Announce from every page that loads this file, so the list covers the board
    // AND the tools. Deferred to a task so the module has finished evaluating.
    setTimeout(startPresence, 0);

    /* ---- last seen ----------------------------------------------------------
     * Presence answers "who is here right now"; this answers "when was this
     * person last here", and has to survive what presence does not:
     *   * a colleague on an older copy of the tools. The first presence code
     *     deleted every presence file older than 24 hours — everyone's last
     *     seen with it — and a copy from before presence writes none at all;
     *   * work done in a tool: editing an intake or report re-stamps no card
     *     when no card field changes, and a card only remembers its LAST writer.
     * So: a folder no older version knows about (.seen), written by every page
     * every few minutes, plus what even old versions leave behind — the
     * per-project locks, and who deleted a card.
     * ---------------------------------------------------------------------- */
    var SEEN_DIR = '.seen';
    var SEEN_EVERY_MS = 5 * 60 * 1000;
    var _seenAt = 0;

    // One file per SESSION, like presence, so two devices never write one file.
    function touchSeen() {
        var user = getUserLabel();
        if (!user) return Promise.resolve(false);
        var now = Date.now();
        if (now - _seenAt < SEEN_EVERY_MS) return Promise.resolve(false);
        _seenAt = now;
        return IO.writeJSON([SEEN_DIR, sessionId() + '.json'], {
            user: user, sessionId: sessionId(), page: presencePage(), at: new Date(now).toISOString()
        }).then(function () { return true; }).catch(function () { _seenAt = 0; return false; });
    }

    // Every trace of someone having worked here, as [{ user, at, source }]. The
    // caller keeps the newest per person. Never rejects.
    function readActivity() {
        var out = [];
        var noop = function () { };
        var seen = IO.list([SEEN_DIR]).then(function (entries) {
            var files = entries.filter(function (e) { return e.kind === 'file' && /\.json$/i.test(e.name); });
            return Promise.all(files.map(function (e) {
                return IO.readJSON([SEEN_DIR, e.name]).then(function (r) { return r && r.user && r.at ? { r: r, file: e.name } : null; }).catch(function () { return null; });
            })).then(function (rows) {
                // Keep each person's newest file, sweep the rest (never the newest).
                var newest = {}, superseded = [];
                rows.filter(Boolean).forEach(function (x) {
                    var name = String(x.r.user).trim(), t = Date.parse(x.r.at) || 0;
                    var prev = newest[name];
                    if (!prev) { newest[name] = { x: x, t: t }; return; }
                    if (t > prev.t) { superseded.push(prev.x.file); newest[name] = { x: x, t: t }; }
                    else superseded.push(x.file);
                });
                Object.keys(newest).forEach(function (n) { out.push({ user: n, at: newest[n].x.r.at, page: newest[n].x.r.page || '', source: 'seen' }); });
                superseded.forEach(function (file) { IO.remove([SEEN_DIR, file]).catch(noop); });
            });
        }).catch(noop);
        // A lock is left behind by every version since cards exist, whichever
        // tool had the project open — the evidence for a colleague on an old copy.
        var locks = IO.list([PROJECTS_DIR]).then(function (dirs) {
            return Promise.all(dirs.filter(function (d) { return d.kind === 'directory'; }).map(function (d) {
                return IO.readJSON([PROJECTS_DIR, d.name, LOCK_FILE]).then(function (l) {
                    if (l && l.user && l.at) out.push({ user: String(l.user), at: l.at, source: 'lock' });
                }).catch(noop);
            }));
        }).catch(noop);
        _lastDeletedStamps.forEach(function (d) { out.push({ user: d.user, at: d.at, source: 'deleted-card' }); });
        return Promise.all([seen, locks]).then(function () { return out; });
    }

    // The names in a people.json list. Entries are { name, email, phone }
    // objects; the oldest files held plain strings. Both read as a name, once
    // each — the dashboard compared the objects themselves as text, so it
    // recognised no product manager at all.
    function personNames(list) {
        var out = [];
        (list || []).forEach(function (p) {
            var n = String((p && typeof p === 'object') ? (p.name || '') : (p == null ? '' : p)).replace(/\s+/g, ' ').trim();
            if (n && out.indexOf(n) < 0) out.push(n);
        });
        return out;
    }

    // Whether `label` (the board name label, or the server's user) is one of
    // the registry's product managers — the people who may approve a claim.
    // Resolved like every other label, so "Luke" counts for Luke Zuijderwijk
    // when he is the only Luke.
    function isProductManager(label, people) {
        var pms = personNames(people && people.productManagers);
        var me = resolvePersonName(label, pms).toLowerCase();
        return !!me && pms.some(function (n) { return n.toLowerCase() === me; });
    }

    // Who a typed name label is in the people registry. The board used to ask
    // for a name with "e.g. Luke" as the example, so labels are often a first
    // name or a nickname ("Chris" for Christiaan Mulder) that never matched
    // the registry's full names: one colleague showed up as two people, and the
    // one assigned to the projects never had a "last seen".
    //   the same name in any case -> that person;
    //   the ONE registry name whose first name IS the label -> that person
    //   ("Bas" is Bas de Vries, although Bastiaan de Vries also starts so);
    //   otherwise the ONE registry name that starts with the label (3+ letters)
    //   -> that person; ambiguous or unknown -> the label as typed.
    function resolvePersonName(label, names) {
        var l = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
        if (!l) return '';
        var list = personNames(names);
        var low = l.toLowerCase();
        for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === low) return list[i];
        if (low.length < 3) return l;
        var first = list.filter(function (n) { return n.toLowerCase().split(' ')[0] === low; });
        if (first.length === 1) return first[0];
        var hits = list.filter(function (n) { return n.toLowerCase().indexOf(low) === 0; });
        return hits.length === 1 ? hits[0] : l;
    }

    // ---- migration: board.json -> cards/ -----------------------------------
    // Idempotent: does nothing once meta.json exists. The original board.json is
    // renamed, not deleted, so a mistake here is recoverable by hand.
    function migrateToCards() {
        return readMeta().then(function (m) {
            if (m) return { migrated: false, reason: 'already-on-cards' };
            return readLegacyManifest().then(function (manifest) {
                var projects = manifest.projects || [];
                var stamp = new Date().toISOString();
                var writes = projects.filter(function (p) { return p && p.id; }).map(function (p) {
                    var card = {};
                    Object.keys(p).forEach(function (k) { card[k] = p[k]; });
                    card.rev = 1;
                    card.updatedAt = p.updatedAt || stamp;
                    card.updatedBy = p.updatedBy || '';
                    card.deletedAt = null;
                    return IO.writeJSON(cardPath(p.id), card);
                });
                return Promise.all(writes).then(function () {
                    var people = manifest.people || {};
                    return IO.writeJSON([PEOPLE_FILE], {
                        schemaVersion: DB_SCHEMA,
                        rev: 1,
                        commercials: people.commercials || [],
                        productManagers: people.productManagers || [],
                        updatedAt: stamp
                    });
                }).then(function () {
                    // Keep the original next to the new store rather than deleting
                    // it. There is no rename in this API, so copy then remove.
                    return IO.copyFile([MANIFEST_NAME], [LEGACY_BACKUP_NAME])
                        .then(function () { return IO.remove([MANIFEST_NAME]); })
                        .catch(function () { /* leave board.json in place if this fails */ });
                }).then(function () {
                    return writeMeta({
                        isPerfoTecBoardDb: true,
                        schemaVersion: DB_SCHEMA,
                        createdAt: stamp,
                        migratedFrom: MANIFEST_NAME,
                        cardCount: projects.length
                    });
                }).then(function () {
                    return { migrated: true, cards: projects.length };
                });
            });
        });
    }

    /* ---- compatibility shim -------------------------------------------------
     * board.html and the four tools speak "manifest": read the whole thing,
     * patch a bit, write the whole thing back. Rewriting all five callers at
     * once would be a big-bang change, so instead readManifest() assembles a
     * manifest out of the card files and writeManifest() takes it apart again
     * and writes ONLY the cards that actually changed.
     *
     * That is what removes the lost update: two tools autosaving different
     * projects now write different files, and a caller that patches one card
     * can no longer flatten someone else's card on the way out.
     * ---------------------------------------------------------------------- */

    // Snapshot of the last readManifest(), used to diff on write: card id ->
    // { rev, json }. Only ids in here may be deleted by a write — a card that
    // appeared after our read belongs to someone else and is left alone.
    var _lastRead = null;
    // Reads can overlap (a focus reload during a save's own re-read). Only a read
    // that STARTED after the one behind the current snapshot may replace it, so a
    // slow older read never moves the snapshot back behind the folder.
    var _readGen = 0, _lastReadGen = 0;

    function readManifest() {
        var gen = ++_readGen;
        return dbMode().then(function (mode) {
            if (mode === 'legacy') return readLegacyManifest();
            return Promise.all([readCards(false), readPeople()]).then(function (res) {
                var cards = res[0], people = res[1];
                var snap = {
                    cards: {},
                    peopleRev: people.rev,
                    peopleJson: JSON.stringify({
                        commercials: people.commercials || [],
                        productManagers: people.productManagers || []
                    })
                };
                var manifest = {
                    schemaVersion: DB_SCHEMA,
                    isPerfoTecBoard: true,
                    projects: cards,
                    people: { commercials: people.commercials, productManagers: people.productManagers }
                };
                // migratePhases rewrites phases IN PLACE on these very objects, so
                // the snapshot has to be taken after it. Taken before, a migrated
                // card differed from its snapshot from the moment it was read, and
                // was rewritten on every single save — the same never-converging
                // write as the duplicate-id case above.
                migratePhases(manifest);
                cards.forEach(function (c) { snap.cards[c.id] = { rev: c.rev, json: JSON.stringify(c) }; });
                if (gen > _lastReadGen) { _lastRead = snap; _lastReadGen = gen; }
                return manifest;
            });
        });
    }

    function writeManifest(manifest) {
        return dbMode().then(function (mode) {
            if (mode === 'legacy') return writeLegacyManifest(manifest);

            var projects = (manifest && manifest.projects) || [];
            var snap = _lastRead || { cards: {}, peopleRev: null };
            var seen = {}, jobs = [], conflicts = [];

            projects.forEach(function (p) {
                if (!p || !p.id) return;
                seen[p.id] = true;
                var before = snap.cards[p.id];
                // Compare without the write-stamped fields, otherwise every card
                // looks changed on every save.
                if (before && sameCardPayload(before.json, p)) return;
                jobs.push(writeCardRebasing(p, before)
                    .catch(function (err) {
                        if (err && err.code === 'CONFLICT') { conflicts.push(err); return null; }
                        throw err;
                    }));
            });

            // Only cards we actually read may be removed.
            Object.keys(snap.cards).forEach(function (id) {
                if (!seen[id]) jobs.push(softDeleteCard(id));
            });

            var peopleChanged = manifest && manifest.people && (
                !snap.peopleJson ||
                snap.peopleJson !== JSON.stringify({
                    commercials: manifest.people.commercials || [],
                    productManagers: manifest.people.productManagers || []
                })
            );
            if (peopleChanged) jobs.push(writePeople(manifest.people, snap.peopleRev));

            return trackWrite(Promise.all(jobs).then(function () {
                // Refresh the snapshot BEFORE deciding the outcome. A partly
                // successful write still moved the folder on: some cards were
                // written, and people.json may have been too. Throwing without
                // re-reading left _lastRead describing a folder that no longer
                // exists, so the NEXT save diffed against stale revs (another
                // self-conflict) and — worse — writePeople took its rev-mismatch
                // branch, which merges additively by name: a person just deleted
                // came back, and a rename left both spellings in the list.
                // The folder as re-read is also the result: the board takes it into
                // memory, so its next save does not diff an older copy against it.
                return readManifest().then(function (fresh) {
                    if (conflicts.length) {
                        var e = new Error(conflicts.length === 1
                            ? conflicts[0].message + '. Reload the board to see their version.'
                            : conflicts.length + ' cards were changed by someone else while you were editing. Reload the board.');
                        e.code = 'CONFLICTS';
                        e.conflicts = conflicts;
                        e.fresh = fresh;   // the folder as re-read, winners included
                        throw e;
                    }
                    return fresh;
                });
            }));
        });
    }

    // Field-level compare that ignores the bookkeeping writeCard() stamps.
    var STAMP_FIELDS = { rev: 1, updatedAt: 1, updatedBy: 1 };
    function sameCardPayload(beforeJson, after) {
        function strip(o) {
            var c = {};
            Object.keys(o || {}).forEach(function (k) {
                if (STAMP_FIELDS[k]) return;
                c[k] = o[k];
            });
            return JSON.stringify(c);
        }
        var before;
        try { before = JSON.parse(beforeJson); } catch (e) { return false; }
        return strip(before) === strip(after);
    }

    // Which fields actually differ between two versions of a card, ignoring the
    // write stamps. `set` are fields to write, `removed` are fields to drop.
    function cardFieldDiff(before, after) {
        var set = {}, removed = [];
        Object.keys(after || {}).forEach(function (k) {
            if (STAMP_FIELDS[k]) return;
            if (JSON.stringify(after[k]) !== JSON.stringify((before || {})[k])) set[k] = after[k];
        });
        Object.keys(before || {}).forEach(function (k) {
            if (STAMP_FIELDS[k]) return;
            if (!(k in (after || {}))) removed.push(k);
        });
        return { set: set, removed: removed, keys: Object.keys(set).concat(removed) };
    }

    /* Write a card, and REBASE instead of giving up when it moved on disk.
     *
     * Every board write is a field-level patch — rename a person on this card,
     * move its phase, tick an action — never a whole-document replacement. So a
     * card that changed underneath us is usually not a real conflict: the
     * Pipedrive sync runs on a schedule and stamps crmSyncedAt/pipedriveDealUrl
     * on cards nobody is looking at, and the board's snapshot is from whenever it
     * last read the folder. Failing there produced the worst possible outcome:
     * the user's edit was dropped AND they were told "someone else was faster —
     * <their own name> changed this", which nobody can act on.
     *
     * So: replay only OUR changed fields onto the version now on disk and write
     * again against its rev. A genuine conflict — both sides changing the SAME
     * field — still surfaces, because that is the only case where a person has to
     * choose. Exactly one retry, so a busy folder cannot spin here.
     */
    function writeCardRebasing(card, before) {
        var baseRev = before ? before.rev : card.rev;
        return writeCard(card, { baseRev: baseRev }).catch(function (err) {
            if (!err || err.code !== 'CONFLICT' || !before || !err.theirs) throw err;
            var beforeObj;
            try { beforeObj = JSON.parse(before.json); } catch (e) { throw err; }
            var theirs = err.theirs;
            var mine = cardFieldDiff(beforeObj, card);
            var theirChange = cardFieldDiff(beforeObj, theirs);
            // Both sides bringing a field to the same value — two writers clearing
            // the same "not yet in the dashboard" note, say — is agreement, not a
            // conflict to put in front of the user.
            var agreed = function (k) {
                if (mine.removed.indexOf(k) !== -1) return !(k in theirs);
                return JSON.stringify(mine.set[k]) === JSON.stringify(theirs[k]);
            };
            var todo = mine.keys.filter(function (k) { return !agreed(k); });
            if (!todo.length) return theirs;               // nothing of ours left to apply
            var collides = todo.some(function (k) { return theirChange.keys.indexOf(k) !== -1; });
            if (collides) throw err;                        // a real disagreement
            var merged = {};
            Object.keys(theirs).forEach(function (k) { merged[k] = theirs[k]; });
            Object.keys(mine.set).forEach(function (k) { merged[k] = mine.set[k]; });
            mine.removed.forEach(function (k) { delete merged[k]; });
            merged.id = card.id;
            return writeCard(merged, { baseRev: Number(theirs.rev || 0) });
        });
    }

    /* ========================================================================
     * BACKUPS
     * ------------------------------------------------------------------------
     *   _backups/daily/<mon..sun>.json    structure only, 7 slots — next Monday
     *                                     overwrites the previous Monday
     *   _backups/weekly/<YYYY>-W<NN>.json structure only, on Mondays, keep 4
     *   _backups/monthly/<YYYY-MM>/       FULL copy, on the 1st, keep 12
     *   _backups/state.json               bookkeeping
     *
     * "Structure" = meta + people + every card + products. That is ~400 KB and
     * it is what a bug or a bad migration destroys. The phase exports run to
     * 65 MB each, so copying those daily would bury the OneDrive sync; between
     * two monthly full copies they are covered by SharePoint version history,
     * and the daily bundle carries an index of them (name, size, date) so a
     * restore tells you exactly what to fetch back.
     *
     * Runs opportunistically when the board opens: whoever opens it first that
     * day makes the snapshot. Deterministic filenames mean a second writer that
     * same day overwrites the same file with the same content instead of
     * creating a mess.
     * ==================================================================== */

    var BACKUP_DIR = '_backups';
    var BACKUP_STATE = 'state.json';
    var DAY_SLOTS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    var KEEP_WEEKLY = 4;
    var KEEP_MONTHLY = 12;
    var INCOMPLETE_MARK = '.incomplete';

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // ISO-8601 week number: weeks start on Monday and week 1 is the one holding
    // the first Thursday, so the year in the label is not always the calendar
    // year (1 Jan 2027 is 2026-W53).
    function isoWeekLabel(d) {
        var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        var day = t.getUTCDay() || 7;              // Sunday = 7
        t.setUTCDate(t.getUTCDate() + 4 - day);    // move to the Thursday of this week
        var year = t.getUTCFullYear();
        var week1 = new Date(Date.UTC(year, 0, 4));
        var w1day = week1.getUTCDay() || 7;
        week1.setUTCDate(week1.getUTCDate() + 4 - w1day);
        var week = Math.round((t - week1) / (7 * 24 * 3600 * 1000)) + 1;
        return year + '-W' + pad2(week);
    }

    function monthLabel(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
    function dayISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

    function readBackupState() {
        return IO.readJSON([BACKUP_DIR, BACKUP_STATE]).then(function (s) {
            return s || { lastDaily: null, lastWeekly: null, lastMonthly: null, runs: [] };
        });
    }

    function writeBackupState(state) {
        // Keep a short audit trail: who made which snapshot, and when.
        state.runs = (state.runs || []).slice(-30);
        return IO.writeJSON([BACKUP_DIR, BACKUP_STATE], state);
    }

    // An index of the phase exports, so a structure-only restore can tell you
    // which big files existed and where to get them back from.
    function buildPhaseIndex() {
        return IO.list([PROJECTS_DIR]).then(function (entries) {
            var dirs = entries.filter(function (e) { return e.kind === 'directory'; });
            return Promise.all(dirs.map(function (d) {
                return IO.list([PROJECTS_DIR, d.name]).then(function (files) {
                    return Promise.all(files.filter(function (f) {
                        return f.kind === 'file' && /\.json$/i.test(f.name) && f.name !== LOCK_FILE;
                    }).map(function (f) {
                        return IO.stat([PROJECTS_DIR, d.name, f.name]).then(function (st) {
                            return { file: f.name, size: st ? st.size : null, lastModified: st ? new Date(st.lastModified).toISOString() : null };
                        });
                    })).then(function (files2) {
                        return { projectId: d.name, files: files2 };
                    });
                });
            }));
        });
    }

    // The small, high-value snapshot.
    function buildStructureBundle() {
        return Promise.all([
            readMeta(),
            readPeople(),
            readCards(true),          // tombstones included: a restore must not resurrect deleted cards
            readProductIndex(),
            readAllProducts(true).catch(function () { return []; }),   // same for products
            buildPhaseIndex().catch(function () { return []; })
        ]).then(function (r) {
            return {
                isPerfoTecBoardBackup: true,
                kind: 'structure',
                schemaVersion: DB_SCHEMA,
                createdAt: new Date().toISOString(),
                createdBy: getUserLabel() || '',
                meta: r[0],
                people: r[1],
                cards: r[2],
                productIndex: r[3],
                products: r[4],
                phaseIndex: r[5]
            };
        });
    }

    // ---- full copy (monthly) ------------------------------------------------
    // Never back up the backups, the advisory locks or sync artefacts.
    function skipFromFullCopy(name, kind) {
        if (name === BACKUP_DIR) return true;
        if (name === LOCK_FILE) return true;
        if (name === PRESENCE_DIR) return true;   // who was online last month is not data
        if (name === SEEN_DIR) return true;
        if (kind === 'file' && isSyncArtefact(name)) return true;
        return false;
    }

    function copyTree(fromPath, toPath, onFile) {
        return IO.list(fromPath).then(function (entries) {
            return entries.reduce(function (chain, e) {
                if (skipFromFullCopy(e.name, e.kind)) return chain;
                return chain.then(function () {
                    if (e.kind === 'directory') {
                        return copyTree(fromPath.concat(e.name), toPath.concat(e.name), onFile);
                    }
                    return IO.copyFile(fromPath.concat(e.name), toPath.concat(e.name)).then(function () {
                        if (onFile) onFile(fromPath.concat(e.name).join('/'));
                    });
                });
            }, Promise.resolve());
        });
    }

    // Streamed, file-by-file — a single 100 MB JSON bundle would blow up the tab.
    function runFullBackup(label, onProgress) {
        var dest = [BACKUP_DIR, 'monthly', label];
        var copied = 0;
        return IO.writeJSON(dest.concat(INCOMPLETE_MARK), { startedAt: new Date().toISOString() })
            .then(function () {
                return copyTree([], dest.concat('db'), function (path) {
                    copied++;
                    if (onProgress) onProgress({ copied: copied, current: path });
                });
            })
            .then(function () {
                return IO.writeJSON(dest.concat('manifest.json'), {
                    isPerfoTecBoardBackup: true,
                    kind: 'full',
                    schemaVersion: DB_SCHEMA,
                    label: label,
                    createdAt: new Date().toISOString(),
                    createdBy: getUserLabel() || '',
                    fileCount: copied
                });
            })
            .then(function () { return IO.remove(dest.concat(INCOMPLETE_MARK)); })
            .then(function () { return { label: label, files: copied }; });
    }

    // A run that was interrupted (tab closed mid-copy) leaves .incomplete behind.
    // Clear the half-copied folder so the next attempt starts clean.
    function cleanupIncompleteFullBackups() {
        return IO.list([BACKUP_DIR, 'monthly']).then(function (entries) {
            var dirs = entries.filter(function (e) { return e.kind === 'directory'; });
            return Promise.all(dirs.map(function (d) {
                return IO.readJSON([BACKUP_DIR, 'monthly', d.name, INCOMPLETE_MARK]).then(function (mark) {
                    if (!mark) return null;
                    return IO.remove([BACKUP_DIR, 'monthly', d.name], true).then(function () { return d.name; });
                });
            })).then(function (removed) { return removed.filter(Boolean); });
        });
    }

    function pruneBackups() {
        var jobs = [];
        jobs.push(IO.list([BACKUP_DIR, 'weekly']).then(function (entries) {
            var files = entries.filter(function (e) { return e.kind === 'file' && /^\d{4}-W\d{2}\.json$/.test(e.name); })
                .map(function (e) { return e.name; }).sort();
            var doomed = files.slice(0, Math.max(0, files.length - KEEP_WEEKLY));
            return Promise.all(doomed.map(function (n) { return IO.remove([BACKUP_DIR, 'weekly', n]); }))
                .then(function () { return { weeklyRemoved: doomed }; });
        }));
        jobs.push(IO.list([BACKUP_DIR, 'monthly']).then(function (entries) {
            var dirs = entries.filter(function (e) { return e.kind === 'directory' && /^\d{4}-\d{2}$/.test(e.name); })
                .map(function (e) { return e.name; }).sort();
            var doomed = dirs.slice(0, Math.max(0, dirs.length - KEEP_MONTHLY));
            return Promise.all(doomed.map(function (n) { return IO.remove([BACKUP_DIR, 'monthly', n], true); }))
                .then(function () { return { monthlyRemoved: doomed }; });
        }));
        return Promise.all(jobs).then(function (r) {
            return { weeklyRemoved: r[0].weeklyRemoved, monthlyRemoved: r[1].monthlyRemoved };
        });
    }

    // Called when the board opens. Only writes what is actually due, so five
    // people opening the board on Monday morning produce one set of snapshots.
    //   opts.now         inject a date (tests)
    //   opts.onProgress  progress of the monthly full copy
    //   opts.skipFull    do the bookkeeping but not the (slow) full copy
    //   opts.force       redo today's structure snapshot ("Back up now" button)
    function runDueBackups(opts) {
        opts = opts || {};
        var now = opts.now ? new Date(opts.now) : new Date();
        var today = dayISO(now);
        var daySlot = DAY_SLOTS[now.getDay()];
        var week = isoWeekLabel(now);
        var month = monthLabel(now);
        var done = { daily: null, weekly: null, monthly: null, pruned: null, cleaned: null };

        return dbMode().then(function (mode) {
            if (mode !== 'cards') return done;   // nothing to snapshot yet
            return readBackupState().then(function (state) {
                var chain = Promise.resolve();

                // Daily — one per calendar day, into this weekday's slot.
                if (state.lastDaily !== today || opts.force) {
                    chain = chain.then(function () {
                        return buildStructureBundle().then(function (bundle) {
                            bundle.slot = daySlot;
                            return IO.writeJSON([BACKUP_DIR, 'daily', daySlot + '.json'], bundle);
                        }).then(function () {
                            state.lastDaily = today;
                            done.daily = daySlot;
                        });
                    });
                }

                // Weekly — one per ISO week, taken at the first board open of that
                // week. On a normal week that IS Monday. Deliberately not gated on
                // getDay() === 1: a week where nobody opened the board on Monday
                // would otherwise get no weekly snapshot at all, and a restore
                // point per week is the point of keeping four of them.
                if (state.lastWeekly !== week) {
                    chain = chain.then(function () {
                        return buildStructureBundle().then(function (bundle) {
                            bundle.slot = week;
                            return IO.writeJSON([BACKUP_DIR, 'weekly', week + '.json'], bundle);
                        }).then(function () {
                            state.lastWeekly = week;
                            done.weekly = week;
                        });
                    });
                }

                // Monthly full copy — on the 1st.
                if (state.lastMonthly !== month && now.getDate() === 1 && !opts.skipFull) {
                    chain = chain.then(function () {
                        return cleanupIncompleteFullBackups().then(function (cleaned) {
                            done.cleaned = cleaned;
                            return runFullBackup(month, opts.onProgress);
                        }).then(function (res) {
                            state.lastMonthly = month;
                            done.monthly = res;
                        });
                    });
                }

                return chain.then(function () {
                    if (!done.daily && !done.weekly && !done.monthly) return done;
                    return pruneBackups().then(function (pruned) {
                        done.pruned = pruned;
                        state.runs = (state.runs || []).concat([{
                            at: now.toISOString(), by: getUserLabel() || '',
                            daily: done.daily, weekly: done.weekly,
                            monthly: done.monthly ? done.monthly.label : null
                        }]);
                        return writeBackupState(state).then(function () { return done; });
                    });
                });
            });
        });
    }

    // What is available to restore from.
    function listBackups() {
        function ls(kind) {
            return IO.list([BACKUP_DIR, kind]).then(function (entries) {
                return Promise.all(entries.filter(function (e) {
                    return kind === 'monthly' ? e.kind === 'directory' : (e.kind === 'file' && /\.json$/i.test(e.name));
                }).map(function (e) {
                    var name = e.name.replace(/\.json$/i, '');
                    if (kind === 'monthly') {
                        return IO.readJSON([BACKUP_DIR, kind, e.name, 'manifest.json']).then(function (m) {
                            return { kind: kind, name: name, createdAt: m && m.createdAt, files: m && m.fileCount, complete: !!m };
                        });
                    }
                    return IO.stat([BACKUP_DIR, kind, e.name]).then(function (st) {
                        return { kind: kind, name: name, size: st && st.size, createdAt: st ? new Date(st.lastModified).toISOString() : null, complete: true };
                    });
                }));
            });
        }
        return Promise.all([ls('daily'), ls('weekly'), ls('monthly')]).then(function (r) {
            return { daily: r[0], weekly: r[1], monthly: r[2] };
        });
    }

    function readStructureBackup(kind, name) {
        return IO.readJSON([BACKUP_DIR, kind, name + '.json']);
    }

    // Restore is never automatic — the caller shows what is in the bundle and
    // asks first. Cards are written with force, because the whole point is to
    // overwrite what is there now.
    function restoreStructureBackup(bundle) {
        if (!bundle || !bundle.isPerfoTecBoardBackup) return Promise.reject(new Error('Not a board backup'));
        var cards = bundle.cards || [];
        return cards.reduce(function (chain, c) {
            return chain.then(function () { return writeCard(c, { force: true }); });
        }, Promise.resolve()).then(function () {
            if (!bundle.people) return null;
            return writePeople(bundle.people, null);
        }).then(function () {
            // force, for the same reason the cards above are forced: a restore is
            // an overwrite by definition, and a bundle's records carry the revs
            // they had when it was taken — every one of them would otherwise read
            // as a conflict against the newer copy it is meant to replace, and the
            // restore would stop at the first product.
            return (bundle.products || []).reduce(function (chain, p) {
                return chain.then(function () { return writeProductRecord(p, { force: true }); });
            }, Promise.resolve());
        }).then(function () {
            // bundle.productIndex is not restored: the list is derived from the
            // records just written. Older bundles still carry the field and are
            // read fine — it is simply no longer a thing that can be out of step.
            return null;
        }).then(function () {
            return { cards: cards.length, products: (bundle.products || []).length };
        });
    }

    window.PerfoTecBoard = {
        PHASES: PHASES,
        phaseByKey: PHASE_BY_KEY,
        SEED_FILE: SEED_FILE,
        LEGACY_PHASE_MAP: LEGACY_PHASE_MAP,
        readSeedFile: readSeedFile,
        readSyncState: readSyncState,
        isSupported: isSupported,
        pickRootFolder: pickRootFolder,
        permissionState: permissionState,
        requestAccess: requestAccess,
        getRootHandle: getRootHandle,
        getRootName: getRootName,
        readManifest: readManifest,
        writeManifest: writeManifest,
        // Shared store (schema 2.0). readManifest/writeManifest above transparently
        // sit on top of these, so callers can migrate one at a time.
        DB_SCHEMA: DB_SCHEMA,
        IO: IO,
        dbMode: dbMode,
        readMeta: readMeta,
        migrateToCards: migrateToCards,
        readCards: readCards,
        readCard: readCard,
        writeCard: writeCard,
        relinkProductCards: relinkProductCards,
        listCardIds: listCardIds,
        softDeleteCard: softDeleteCard,
        restoreCard: restoreCard,
        purgeCard: purgeCard,
        readPeople: readPeople,
        writePeople: writePeople,
        // Films: the material register
        readFilms: readFilms,
        writeFilms: writeFilms,
        normFilm: normFilm,
        newFilmId: newFilmId,
        filmLabel: filmLabel,
        matchFilm: matchFilm,
        filmTdsRatio: filmTdsRatio,
        filmPackRatio: filmPackRatio,
        FILM_POLYMERS: FILM_POLYMERS,
        FILM_FORMATS: FILM_FORMATS,
        FILM_PACK_TYPES: FILM_PACK_TYPES,
        lastSyncArtefacts: lastSyncArtefacts,
        scanRootArtefacts: scanRootArtefacts,
        getUserLabel: getUserLabel,
        setUserLabel: setUserLabel,
        touchLock: touchLock,
        readLock: readLock,
        releaseLock: releaseLock,
        // True while a write is still on its way to disk. The board checks this
        // before an automatic refresh: re-reading mid-write would show the file
        // as it was before the change and undo it on screen.
        hasPendingWrites: function () { return _pendingWrites > 0; },

        // Presence: who else has this database open
        readPresence: readPresence,
        touchPresence: touchPresence,
        startPresence: startPresence,
        stopPresence: stopPresence,
        sessionId: sessionId,
        PRESENCE_STALE_MS: PRESENCE_STALE_MS,
        readActivity: readActivity,
        resolvePersonName: resolvePersonName,
        personNames: personNames,
        isProductManager: isProductManager,
        readLegacyManifest: readLegacyManifest,
        // Backups
        BACKUP_DIR: BACKUP_DIR,
        runDueBackups: runDueBackups,
        listBackups: listBackups,
        readBackupState: readBackupState,
        buildStructureBundle: buildStructureBundle,
        readStructureBackup: readStructureBackup,
        restoreStructureBackup: restoreStructureBackup,
        runFullBackup: runFullBackup,
        pruneBackups: pruneBackups,
        isoWeekLabel: isoWeekLabel,
        readPhaseFile: readPhaseFile,
        readProjectData: readProjectData,
        hasContent: hasContent,
        copyProjectFiles: copyProjectFiles,
        repairEmptiedCopy: repairEmptiedCopy,
        stripTrialResults: stripTrialResults,
        trialResultsIn: trialResultsIn,
        measurementQuality: measurementQuality,
        isProductTrial: isProductTrial,
        trialStatus: trialStatus,
        summariseTrial: summariseTrial,
        qualityLimit: QUALITY_LIMIT,
        parseTrialCurve: parseTrialCurve,
        curveShelfLife: curveShelfLife,
        trialRowRole: trialRowRole,
        trialRows: trialRows,
        isRunningTrial: isRunningTrial,
        runningTrials: runningTrials,
        verificationProposal: verificationProposal,
        trialDataGaps: trialDataGaps,
        fillTrialFields: fillTrialFields,
        acceptDataChecks: acceptDataChecks,
        HUB_FORMAT: HUB_FORMAT,
        normHubCatalogue: normHubCatalogue,
        readHub: readHub,
        writeHub: writeHub,
        hubNameKey: hubNameKey,
        hubProductOf: hubProductOf,
        hubFilmOf: hubFilmOf,
        hubVarietyState: hubVarietyState,
        hubVarietiesOf: hubVarietiesOf,
        hubRespirationRecord: hubRespirationRecord,
        hubRespirationCurve: hubRespirationCurve,
        HUB_RR_MIN_TEMPS: HUB_RR_MIN_TEMPS,
        hubSyncFilms: hubSyncFilms,
        hubRespirationsOf: hubRespirationsOf,
        PACK_PERF: PACK_PERF,
        PACK_FLUSH: PACK_FLUSH,
        trialBestPractice: trialBestPractice,
        packSizeBand: packSizeBand,
        tempGroupOf: tempGroupOf,
        trialConfigurations: trialConfigurations,
        transmissionPoints: transmissionPoints,
        transmissionCurve: transmissionCurve,
        transmissionPerKgAt: transmissionPerKgAt,
        transmissionAdvice: transmissionAdvice,
        cultivarFromTitle: cultivarFromTitle,
        variantPackType: variantPackType,
        trialDataChecks: trialDataChecks,
        medianOf: medianOf,
        plausibleTv: plausibleTv,
        MIN_PLAUSIBLE_TV: MIN_PLAUSIBLE_TV,
        readProductTrials: readProductTrials,
        applyReportToProduct: applyReportToProduct,
        trialRowCount: trialRowCount,
        importTrialIntoProduct: importTrialIntoProduct,
        readProjectTitle: readProjectTitle,
        readPhaseFileHead: readPhaseFileHead,
        projectTitle: projectTitle,
        measurementLegacyQuality: measurementLegacyQuality,
        writePhaseFile: writePhaseFile,
        deleteProjectFiles: deleteProjectFiles,
        newId: newId,
        scaleImage: scaleImage,
        // Products (shared with the Product Dashboard)
        PRODUCTS_DIR: PRODUCTS_DIR,
        PRODUCT_INDEX: PRODUCT_INDEX,
        productSummary: productSummary,
        buildProductIndex: buildProductIndex,
        readProductIndex: readProductIndex,
        // Deprecated no-op, kept so an older cached page degrades quietly. The
        // product list is derived; nothing writes an index file.
        writeProductIndex: writeProductIndex,
        legacyProductIndexPresent: legacyProductIndexPresent,
        readProduct: readProduct,
        saveProductConflictCopy: saveProductConflictCopy,
        readAllProducts: readAllProducts,
        writeProduct: writeProduct,
        writeProductRecord: writeProductRecord,
        deleteProduct: deleteProduct,
        restoreProduct: restoreProduct,
        readDeletedProducts: readDeletedProducts,
        purgeProduct: purgeProduct,
        readDeletedCards: readDeletedCards,
        listProductIds: listProductIds,
        readProductStamps: readProductStamps,
        hasProductStore: hasProductStore,
        importProductBackup: importProductBackup,
        resolveProductId: resolveProductId,
        makeProductId: makeProductId,
        newProductRecord: newProductRecord,
        normaliseProductName: normaliseProductName,
        cleanAliases: cleanAliases,
        productNames: productNames,
        // Navigation / unsaved-work coordination
        registerFlush: registerFlush,
        goToBoard: goToBoard,
        boardUrl: boardUrl,
        flushPendingWork: flushPendingWork,
        mountBackToBoardButton: mountBackToBoardButton,
        // Phase handoff
        currentPhaseKey: currentPhaseKey,
        nextPhaseOf: nextPhaseOf,
        toolUrl: toolUrl
    };
})();

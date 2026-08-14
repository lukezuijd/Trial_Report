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
        _lastArtefacts = [];
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
        return false;
    }

    // Read a project's data, preferring `preferPhase`'s file but falling back to
    // the most-advanced phase file that has REAL content (newest → oldest). This
    // makes a tool open with the latest meaningful content even when its own phase
    // file is missing OR is a blank stub that shadowed earlier data (the drag
    // "opens empty" bug). If nothing has content, returns the first file that
    // exists (so a genuinely new project still opens); null if none exist.
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
                        return tryNext(idx + 1, firstExisting || d || null);
                    });
                }
                return tryNext(0, null);
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return null;
                throw err;
            });
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
     *     products.json              index: [{id,name,variety,state,…}]
     *     products/<productId>.json  full record incl. formData
     * ==================================================================== */

    var PRODUCTS_DIR = 'products';
    var PRODUCT_INDEX = 'products.json';

    function emptyProductIndex() {
        return { schemaVersion: '1.0', isPerfoTecProducts: true, products: [] };
    }

    // The listing fields the board needs — deliberately without formData, so
    // reading the index never pulls in the attached sheet HTML.
    function productSummary(record) {
        var fd = record.formData || {};
        var sheet = fd['product-sheet'] || {};
        return {
            id: record.id,
            name: record.name || '',
            variety: record.variety || '',
            state: record.state || '',
            imageUrl: record.imageUrl || '',
            hasSheet: !!sheet.html,
            sheetFileName: sheet.fileName || '',
            updatedAt: record.updatedAt || null
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

    function readProductIndex() {
        return requireGrantedRoot().then(function (root) {
            return readJSONFromDir(root, PRODUCT_INDEX).then(function (idx) {
                if (idx && Array.isArray(idx.products)) return idx;
                return emptyProductIndex();
            });
        });
    }

    function writeProductIndex(idx) {
        return trackWrite(requireGrantedRoot().then(function (root) {
            return writeJSONToDir(root, PRODUCT_INDEX, idx || emptyProductIndex());
        }));
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

    // Write the record file only. Bulk callers use this and then write the
    // index once, instead of rewriting the index per product.
    function writeProductRecord(record) {
        if (!record || !record.id) return Promise.reject(new Error('Product needs an id'));
        return trackWrite(requireGrantedRoot().then(function (root) {
            return getProductsDir(root, true).then(function (dir) {
                return writeJSONToDir(dir, record.id + '.json', record);
            });
        }));
    }

    // Single-product save: record file plus its index entry.
    function writeProduct(record) {
        return writeProductRecord(record).then(function () {
            return readProductIndex();
        }).then(function (idx) {
            var list = idx.products || [];
            var found = false;
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === record.id) { list[i] = productSummary(record); found = true; break; }
            }
            if (!found) list.push(productSummary(record));
            idx.products = list;
            return writeProductIndex(idx);
        });
    }

    function deleteProduct(id) {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                return dir.removeEntry(id + '.json');
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return; // already gone
                throw err;
            });
        }).then(function () {
            return readProductIndex();
        }).then(function (idx) {
            idx.products = (idx.products || []).filter(function (p) { return p.id !== id; });
            return writeProductIndex(idx);
        });
    }

    // Enumerate the record files on disk. Used to heal an index that drifted
    // (a write that failed halfway, or files copied in by hand).
    function listProductIds() {
        return requireGrantedRoot().then(function (root) {
            return getProductsDir(root, false).then(function (dir) {
                var ids = [];
                var it = dir.values();
                function step() {
                    return it.next().then(function (res) {
                        if (res.done) return ids;
                        var entry = res.value;
                        if (entry.kind === 'file' && /\.json$/i.test(entry.name)) {
                            ids.push(entry.name.replace(/\.json$/i, ''));
                        }
                        return step();
                    });
                }
                return step();
            }).catch(function (err) {
                if (err && err.name === 'NotFoundError') return [];
                throw err;
            });
        });
    }

    // Every full product record. Reads the index first; when it is missing or
    // has drifted from what is on disk, falls back to the directory listing so
    // a damaged index never hides real data.
    function readAllProducts() {
        return readProductIndex().then(function (idx) {
            var ids = (idx.products || []).map(function (p) { return p.id; });
            return listProductIds().then(function (onDisk) {
                onDisk.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
                var out = [];
                function step(i) {
                    if (i >= ids.length) return out;
                    return readProduct(ids[i]).then(function (rec) {
                        if (rec && rec.id) out.push(rec);
                        return step(i + 1);
                    });
                }
                return Promise.resolve(step(0));
            });
        });
    }

    // Has this root been set up for products yet? Drives the dashboard's
    // one-time migration prompt.
    function hasProductStore() {
        return requireGrantedRoot().then(function (root) {
            return readJSONFromDir(root, PRODUCT_INDEX);
        }).then(function (idx) {
            return !!(idx && Array.isArray(idx.products));
        }).catch(function () { return false; });
    }

    // Migrate a PerfoTec_Database.json payload ({products:[…]}) into the store.
    // Existing records with the same id are overwritten; anything already there
    // under a different id is left alone. Returns the number written.
    function importProductBackup(backup) {
        var records = (backup && Array.isArray(backup.products)) ? backup.products : [];
        var usable = records.filter(function (r) { return r && r.id && !r.isAverage; });
        if (usable.length === 0) return Promise.resolve(0);
        return readProductIndex().then(function (idx) {
            function step(i) {
                if (i >= usable.length) return Promise.resolve();
                return writeProductRecord(usable[i]).then(function () { return step(i + 1); });
            }
            return step(0).then(function () {
                var merged = (idx.products || []).filter(function (p) {
                    return !usable.some(function (r) { return r.id === p.id; });
                });
                usable.forEach(function (r) { merged.push(productSummary(r)); });
                idx.products = merged;
                return writeProductIndex(idx);
            });
        }).then(function () { return usable.length; });
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
    // "bimi broccolini" resolve to the same product.
    function normaliseProductName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function resolveProductId(name, index) {
        var want = normaliseProductName(name);
        if (!want) return Promise.resolve(null);
        var find = function (idx) {
            var list = (idx && idx.products) || [];
            var exact = null, partial = null;
            for (var i = 0; i < list.length; i++) {
                var cand = normaliseProductName(list[i].name + list[i].variety);
                var bare = normaliseProductName(list[i].name);
                if (cand === want || bare === want) { exact = list[i].id; break; }
                if (!partial && (bare.indexOf(want) === 0 || want.indexOf(bare) === 0) && bare.length > 2) partial = list[i].id;
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
            next: 'Next: {phase}', nextTitle: 'Finish this phase and continue in {phase}',
            confirmNext: 'Move this project to {phase}?\n\nThe current data is carried forward and {phase} opens next.'
        },
        nl: {
            label: 'Board', title: 'Terug naar het Project Board', saving: 'Opslaan…',
            next: 'Volgende: {phase}', nextTitle: 'Deze fase afronden en verder in {phase}',
            confirmNext: 'Dit project naar {phase} verplaatsen?\n\nDe huidige data gaat mee en {phase} wordt geopend.'
        },
        es: {
            label: 'Board', title: 'Volver al Project Board', saving: 'Guardando…',
            next: 'Siguiente: {phase}', nextTitle: 'Terminar esta fase y continuar en {phase}',
            confirmNext: '¿Mover este proyecto a {phase}?\n\nLos datos actuales se transfieren y se abrirá {phase}.'
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
    function waitForWrites(maxMs) {
        var deadline = Date.now() + (maxMs || 3000);
        return new Promise(function (resolve) {
            (function poll() {
                if (_pendingWrites <= 0 || Date.now() > deadline) return resolve();
                setTimeout(poll, 60);
            })();
        });
    }

    // Run every registered flush, then wait for the resulting writes. Always
    // resolves — navigation must never be blocked by a failing save.
    function flushPendingWork(maxMs) {
        var jobs = _flushHandlers.map(function (fn) {
            try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve(); }
        });
        var settled = Promise.all(jobs).catch(function () { }).then(function () { return waitForWrites(maxMs); });
        var guard = new Promise(function (resolve) { setTimeout(resolve, (maxMs || 3000) + 1200); });
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

    // ---- Phase handoff ------------------------------------------------------
    // Finishing a phase used to mean: go back to the board and drag the card.
    // These helpers let a tool advance the project itself, which is where the
    // user actually is when the phase is done.

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

    // Carry this phase's data into the next phase, move the card, and open the
    // next tool. Mirrors the board's own drag-and-drop handoff (copy forward only
    // when the target has no real content yet) and stamps phaseChangedAt, which
    // the Pipedrive conflict rule depends on.
    function advanceToNextPhase() {
        var cur = currentPhaseKey();
        var next = cur ? nextPhaseOf(cur) : null;
        var projectId = currentProjectId();
        if (!cur || !next || !projectId) return Promise.resolve(false);

        return flushPendingWork(3000).then(function () {
            // The dashboard imports from the report file; it owns no phase file.
            if (next.key === 'dashboard') return { fileKey: null };
            return readPhaseFile(projectId, next.key).then(function (existing) {
                // Never overwrite a target that already holds real data.
                if (existing && hasContent(existing)) return { fileKey: next.key };
                return readProjectData(projectId, cur).then(function (src) {
                    if (!src || !hasContent(src)) return { fileKey: existing ? next.key : null };
                    return writePhaseFile(projectId, next.key, src).then(function () {
                        return { fileKey: next.key };
                    });
                });
            });
        }).then(function (res) {
            return readManifest().then(function (manifest) {
                var list = manifest.projects || [];
                var idx = -1;
                for (var i = 0; i < list.length; i++) { if (list[i].id === projectId) { idx = i; break; } }
                if (idx < 0) return null;
                var p = list[idx];
                var files = Object.assign({}, p.files || {});
                if (res && res.fileKey) files[res.fileKey] = true;
                var stamp = new Date().toISOString();
                list[idx] = Object.assign({}, p, {
                    phase: next.key,
                    files: files,
                    phaseChangedAt: stamp,
                    updatedAt: stamp
                });
                manifest.projects = list;
                return writeManifest(manifest);
            });
        }).then(function () {
            window.location.assign(toolUrl(next, projectId));
            return true;
        }).catch(function () {
            // Never strand the user on a failed handoff: fall back to the board,
            // where the card can still be dragged by hand.
            window.location.assign(boardUrl());
            return false;
        });
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
        return flushPendingWork(3000).then(function () {
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
            '[data-perfotec-next-phase]{background:#008837;padding-right:13px;' +
            'box-shadow:0 6px 20px rgba(0,136,55,.35)}' +
            '[data-perfotec-next-phase]:hover{background:#016b2c;box-shadow:0 8px 26px rgba(0,136,55,.45);transform:translateY(-1px)}' +
            '[data-ptb-bar] button:focus-visible{outline:3px solid #211A1A;outline-offset:2px}' +
            '[data-ptb-bar] button[disabled]{cursor:progress;opacity:.75;transform:none}' +
            '@media print{[data-ptb-bar],[data-ptb-style]{display:none !important}}' +
            '@media (max-width:520px){[data-ptb-bar]{left:12px;bottom:12px}' +
            '[data-ptb-bar] button{padding:9px 13px;font-size:12px}' +
            '[data-perfotec-next-phase] [data-ptb-label]{display:none}}';
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

        maybeMountNextPhaseButton(bar, txt);
    }

    // The forward handoff only makes sense for a board-linked project that still
    // has a phase to go to, and only once we know the folder is reachable.
    function maybeMountNextPhaseButton(bar, txt) {
        var cur = currentPhaseKey();
        var next = cur ? nextPhaseOf(cur) : null;
        var projectId = currentProjectId();
        if (!next || !projectId) return;

        permissionState().then(function (state) {
            if (state !== 'granted') return;
            if (bar.querySelector('[data-perfotec-next-phase]')) return;

            var label = txt.next.replace('{phase}', next.label);
            var title = txt.nextTitle.replace('{phase}', next.label);

            var nb = document.createElement('button');
            nb.setAttribute('data-perfotec-next-phase', '');
            nb.setAttribute('type', 'button');
            nb.className = 'no-print';
            nb.title = title;
            nb.setAttribute('aria-label', title);
            nb.innerHTML =
                '<span data-ptb-label></span>' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
            nb.querySelector('[data-ptb-label]').textContent = label;
            nb.addEventListener('click', function () {
                if (!window.confirm(txt.confirmNext.split('{phase}').join(next.label))) return;
                nb.disabled = true;
                nb.querySelector('[data-ptb-label]').textContent = txt.saving;
                advanceToNextPhase();
            });
            bar.appendChild(nb);
        }).catch(function () { /* no folder → no handoff button */ });
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

    // Conflict copies found during the last read, so the board can warn instead
    // of pretending the folder is clean.
    var _lastArtefacts = [];
    function lastSyncArtefacts() { return _lastArtefacts.slice(); }

    function readCard(id) {
        return IO.readJSON(cardPath(id));
    }

    // Every card on disk, deleted ones filtered out unless asked for.
    function readCards(includeDeleted) {
        return listCardIds().then(function (ids) {
            return Promise.all(ids.map(function (id) {
                return readCard(id).then(function (c) {
                    if (!c) return null;
                    if (!c.id) c.id = id;   // heal a hand-copied file
                    return c;
                }).catch(function () { return null; });
            }));
        }).then(function (cards) {
            return cards.filter(function (c) {
                if (!c) return false;
                return includeDeleted ? true : !c.deletedAt;
            });
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
            c.deletedAt = null;
            return writeCard(c, { baseRev: c.rev, force: true });
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

    function readManifest() {
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
                cards.forEach(function (c) { snap.cards[c.id] = { rev: c.rev, json: JSON.stringify(c) }; });
                _lastRead = snap;
                var manifest = {
                    schemaVersion: DB_SCHEMA,
                    isPerfoTecBoard: true,
                    projects: cards,
                    people: { commercials: people.commercials, productManagers: people.productManagers }
                };
                return migratePhases(manifest);
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
                jobs.push(writeCard(p, { baseRev: before ? before.rev : p.rev })
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
                if (conflicts.length) {
                    var e = new Error(conflicts.length === 1
                        ? conflicts[0].message + '. Reload the board to see their version.'
                        : conflicts.length + ' cards were changed by someone else while you were editing. Reload the board.');
                    e.code = 'CONFLICTS';
                    e.conflicts = conflicts;
                    throw e;
                }
                // Refresh the snapshot so a second save in the same session
                // diffs against what is now on disk.
                return readManifest().then(function () { return true; });
            }));
        });
    }

    // Field-level compare that ignores the bookkeeping writeCard() stamps.
    function sameCardPayload(beforeJson, after) {
        function strip(o) {
            var c = {};
            Object.keys(o || {}).forEach(function (k) {
                if (k === 'rev' || k === 'updatedAt' || k === 'updatedBy') return;
                c[k] = o[k];
            });
            return JSON.stringify(c);
        }
        var before;
        try { before = JSON.parse(beforeJson); } catch (e) { return false; }
        return strip(before) === strip(after);
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
            readAllProducts().catch(function () { return []; }),
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
            return (bundle.products || []).reduce(function (chain, p) {
                return chain.then(function () { return writeProductRecord(p); });
            }, Promise.resolve());
        }).then(function () {
            if (!bundle.productIndex) return null;
            return writeProductIndex(bundle.productIndex);
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
        listCardIds: listCardIds,
        softDeleteCard: softDeleteCard,
        restoreCard: restoreCard,
        purgeCard: purgeCard,
        readPeople: readPeople,
        writePeople: writePeople,
        lastSyncArtefacts: lastSyncArtefacts,
        getUserLabel: getUserLabel,
        setUserLabel: setUserLabel,
        touchLock: touchLock,
        readLock: readLock,
        releaseLock: releaseLock,
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
        writeProductIndex: writeProductIndex,
        readProduct: readProduct,
        readAllProducts: readAllProducts,
        writeProduct: writeProduct,
        writeProductRecord: writeProductRecord,
        deleteProduct: deleteProduct,
        listProductIds: listProductIds,
        hasProductStore: hasProductStore,
        importProductBackup: importProductBackup,
        resolveProductId: resolveProductId,
        makeProductId: makeProductId,
        newProductRecord: newProductRecord,
        // Navigation / unsaved-work coordination
        registerFlush: registerFlush,
        goToBoard: goToBoard,
        boardUrl: boardUrl,
        flushPendingWork: flushPendingWork,
        mountBackToBoardButton: mountBackToBoardButton,
        // Phase handoff
        currentPhaseKey: currentPhaseKey,
        nextPhaseOf: nextPhaseOf,
        toolUrl: toolUrl,
        advanceToNextPhase: advanceToNextPhase
    };
})();

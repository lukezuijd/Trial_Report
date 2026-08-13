/* ==========================================================================
 * product-tools.js — shared product layer for the PerfoTec forms
 * --------------------------------------------------------------------------
 * Sits next to board-db.js and splits the work in two:
 *   board-db.js       owns storage (folders, files, manifest, product records)
 *   product-tools.js  owns everything the FORMS do with a product — reading a
 *                     product sheet, listing the product database, matching a
 *                     typed name, creating a new product, and turning a chosen
 *                     product into a patch the form merges into its own state.
 *
 * Intake, Proposal and Report all load this, so a product picked in one phase
 * carries into the next when the card is dragged across the board. That is the
 * whole point: one implementation, not three copies that drift apart — which is
 * exactly how Report ended up with a sheet parser that could not read the 2026
 * template while Proposal could.
 *
 * Plain ES5-ish JS with no framework dependency; the forms supply their own UI.
 * Exposes window.PerfoTecProduct.
 * ========================================================================== */
(function () {
    'use strict';

    // The forms run inside Babel/React modules; this file deliberately does not,
    // so it can be a normal <script> loaded before them.

    // === PRODUCT-SHEET IMPORTER ===
    // Parses a PerfoTec product-sheet HTML (the .htm files under
    // /OneDrive/.../Product Sheets/) and extracts the Defects matrix +
    // optimal O₂/CO₂/Temp ranges + ACP value, in the user's selected
    // language.
    //
    // Robust by design: every selector is wrapped so a missing section
    // is silently skipped instead of crashing the import. Returns a
    // partial-update object that the caller merges into project state.

    // Extract the inline `const translations = { nl: {}, en: {...}, es: {...} };`
    // object literal from the product-sheet script. Uses balanced-brace
    // walking so we don't trip over nested objects, and skips over
    // string literals so braces inside translation text don't mismatch.
    const extractProductSheetTranslations = (htmlText) => {
      const startMarker = 'const translations';
      const startIdx = htmlText.indexOf(startMarker);
      if (startIdx === -1) return null;
      const eqIdx = htmlText.indexOf('=', startIdx);
      if (eqIdx === -1) return null;
      const braceStart = htmlText.indexOf('{', eqIdx);
      if (braceStart === -1) return null;
      let depth = 0, i = braceStart, inStr = null, escaped = false;
      while (i < htmlText.length) {
        const c = htmlText[i];
        if (escaped) { escaped = false; i++; continue; }
        if (inStr) {
          if (c === '\\') { escaped = true; i++; continue; }
          if (c === inStr) inStr = null;
          i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      const objLit = htmlText.substring(braceStart, i);
      try {
        // Object literal evaluation — the source is user-supplied but
        // local to their machine; same trust level as the imported file.
        return new Function('return ' + objLit)();
      } catch (e) {
        return null;
      }
    };

    // Strip HTML tags (translation values may contain inline <strong>,
    // <span>, <br>, …). Returns plain text with whitespace collapsed.
    const stripHtml = (html) => {
      if (!html) return '';
      const tmp = document.createElement('div');
      tmp.innerHTML = String(html);
      return tmp.textContent.replace(/\s+/g, ' ').trim();
    };

    // Sheets write numbers in Dutch notation with en-dash ranges
    // ("3,0 – 5,0%"). Convert to the dot decimals and plain hyphen the
    // proposal fields use; the sheet's own wording and unit placement are
    // left intact, so what lands in the field still reads as the sheet
    // states it ("3.0 - 5.0%").
    const normaliseSheetValue = (s) => String(s || '')
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/\s*[–—]\s*/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim();

    // === V2 SHEET SUPPORT ===
    // Sheets produced by the perfotec-product-sheet skill (2026 template)
    // carry all three languages inline as sibling <span data-lang="nl|en|es">
    // and switch with CSS (body.nl / .en / .es) instead of a `translations`
    // object. Reading textContent straight off such a node would glue all
    // three languages together, so resolve the wanted language first.
    //
    // Sibling groups are handled per parent: a node can mix a fully
    // trilingual group with a partially translated one, and each group
    // independently falls back to English and then to its first entry.
    const langText = (el, wanted) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      // <br> carries meaning as a separator; textContent would drop it.
      clone.querySelectorAll('br').forEach(br => br.replaceWith(clone.ownerDocument.createTextNode(' ')));
      const groups = new Map();
      clone.querySelectorAll('[data-lang]').forEach(span => {
        const parent = span.parentNode;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(span);
      });
      groups.forEach(spans => {
        const langs = spans.map(s => s.getAttribute('data-lang'));
        const pick = langs.includes(wanted) ? wanted : (langs.includes('en') ? 'en' : langs[0]);
        spans.forEach(s => { if (s.getAttribute('data-lang') !== pick) s.remove(); });
      });
      return clone.textContent.replace(/\s+/g, ' ').trim();
    };

    // First number in a string, as a plain string ("ACP: 1–2%" → "1").
    const firstNumber = (s) => {
      const m = String(s || '').replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
      return m ? m[0] : '';
    };

    // Parse the 2026 template: defects live in .defect-card blocks and the
    // gas/temperature window in a Parameter/Target/Critical-limit table
    // (td.t-param / td.t-target / td.t-warn), with .card-eyebrow +
    // .card-value tiles as the fallback for values not in that table.
    const parseProductSheetV2 = (doc, wanted, result) => {
      // ── Defects: one .defect-card per defect ──────────────────────────
      const seen = new Set();
      doc.querySelectorAll('.defect-card').forEach((card, i) => {
        const defect = langText(card.querySelector('.defect-name'), wanted);
        // The cause line is prefixed with the localised word for "cause".
        const cause = langText(card.querySelector('.defect-cause'), wanted)
          .replace(/^\s*(oorzaak|cause|causa)\s*:\s*/i, '');
        // Each prevention row is tagged MHP or MAP; a defect can carry
        // several rows per tag, so collect rather than overwrite.
        const mhp = [], map = [];
        card.querySelectorAll('.prev-row').forEach(row => {
          const tag = row.querySelector('.prev-tag');
          const text = langText(row.querySelector('.prev-text'), wanted);
          if (!tag || !text) return;
          if (tag.classList.contains('mhp')) mhp.push(text);
          else if (tag.classList.contains('map')) map.push(text);
        });
        if (!defect && !cause) return;
        const key = defect + '|' + cause;
        if (seen.has(key)) return;
        seen.add(key);
        result.defects.push({
          id: Date.now() + i,
          defect, cause,
          effectMHP: mhp.join(' '),
          effectMAP: map.join(' ')
        });
      });

      // ── Packaging targets table ───────────────────────────────────────
      // Two CO₂ rows exist (initial burst + steady-state); steady-state is
      // the operating window the proposal needs, so it wins.
      let co2FromSteady = false;
      doc.querySelectorAll('tr').forEach(tr => {
        const paramEl = tr.querySelector('td.t-param');
        const targetEl = tr.querySelector('td.t-target');
        if (!paramEl || !targetEl) return;
        const param = langText(paramEl, wanted).toLowerCase();
        const target = normaliseSheetValue(langText(targetEl, wanted));
        const warn = normaliseSheetValue(langText(tr.querySelector('td.t-warn'), wanted));
        if (!target) return;

        const isO2 = /o₂|o2/i.test(param) && !/co₂|co2/i.test(param);
        const isCO2 = /co₂|co2/i.test(param);
        if (isO2) {
          result.o2Target = target;
          // Critical limit reads "ACP: 1 - 2%" — keep only the range.
          if (warn && /acp/i.test(warn)) {
            result.o2Acp = warn.replace(/^.*?acp\s*:?\s*/i, '').trim();
          }
        } else if (isCO2) {
          const steady = /steady/i.test(param);
          if (steady || !co2FromSteady) { result.co2Target = target; co2FromSteady = steady || co2FromSteady; }
          // ">15% = CO₂ injury" — the number is the critical ceiling.
          if (warn && /^[>≥]/.test(warn)) {
            const n = firstNumber(warn);
            if (n) result.co2Max = `${n}%`;
          }
        } else if (/temperat/i.test(param)) {
          result.tempCritical = target;
        } else if (/ethyl|etile/i.test(param)) {
          result.ethyleneProfile = warn ? `${target} (${warn})` : target;
        }
      });

      // ── Card tiles as fallback ────────────────────────────────────────
      // Mirrors the dashboard's own sheet reader (psFindNode), so both
      // tools agree on which tile means what.
      doc.querySelectorAll('.card').forEach(card => {
        const eyebrow = langText(card.querySelector('.card-eyebrow'), wanted).toLowerCase();
        const value = normaliseSheetValue(langText(card.querySelector('.card-value'), wanted));
        if (!eyebrow || !value) return;
        if (!result.o2Acp && /acp|anaerob|umbral/.test(eyebrow)) {
          result.o2Acp = value.replace(/\s*o₂\s*$/i, '').trim();
        } else if (!result.co2Max && /(critical|kritieke|kritiek|crítico).*co/.test(eyebrow)) {
          const n = firstNumber(value);
          if (n) result.co2Max = `${n}%`;
        } else if (!result.tempCritical && /(optimal storage|optimale bewaring|almacenamiento)/.test(eyebrow)) {
          result.tempCritical = value;
        }
      });

      return result;
    };

    // Parse the pre-2026 template: a 4-column table.data-table for defects,
    // .condition-block tiles for the window, and a `translations` object
    // resolved through each cell's data-translate key.
    const parseProductSheetV1 = (doc, htmlText, wanted, result) => {
      // Pull the per-language translation dictionary so we can resolve
      // each cell's `data-translate` key in the user's active language.
      // Falls back to whatever is already in the DOM (typically Dutch)
      // when a language entry is absent or empty.
      const allTrans = extractProductSheetTranslations(htmlText);
      const langDict = (allTrans && allTrans[wanted] && Object.keys(allTrans[wanted]).length > 0)
        ? allTrans[wanted]
        : null;

      // Resolve a single <td> via its `data-translate` key.
      const cellText = (td) => {
        const key = td.getAttribute && td.getAttribute('data-translate');
        if (key && langDict && langDict[key]) return stripHtml(langDict[key]);
        return td.textContent.replace(/\s+/g, ' ').trim();
      };

      // Defects matrix — #common-defects table.data-table tbody tr
      const rows = doc.querySelectorAll('#common-defects table.data-table tbody tr, table.data-table tbody tr');
      const seen = new Set();
      rows.forEach((tr, i) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 4) return;
        const defect = cellText(tds[0]);
        const cause = cellText(tds[1]);
        const effectMHP = cellText(tds[2]);
        const effectMAP = cellText(tds[3]);
        // Drop empty / duplicate rows (some sheets reuse the table
        // markup with placeholders).
        if (!defect && !cause) return;
        const key = defect + '|' + cause;
        if (seen.has(key)) return;
        seen.add(key);
        result.defects.push({
          id: Date.now() + i,
          defect, cause, effectMHP, effectMAP
        });
      });

      // Optimal conditions — section#optimal-conditions .condition-block
      // The numeric values (e.g. "1.0% - 5.0%") are language-independent
      // and sit in `.condition-value`; only category-matching is needed.
      const blocks = doc.querySelectorAll('#optimal-conditions .condition-block, .condition-block');
      blocks.forEach(block => {
        const title = (block.querySelector('.condition-title')?.textContent || '').trim();
        const value = (block.querySelector('.condition-value')?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) return;
        if (/O₂|O2/i.test(title) && !/CO/i.test(title)) result.o2Target = value;
        else if (/CO₂|CO2/i.test(title)) result.co2Target = value;
        else if (/Temp/i.test(title)) result.tempCritical = value;
      });

      // ACP — pick numeric range from the res_box_text paragraph in
      // the user's language if available, else from the DOM. Numbers
      // themselves are language-independent.
      let acpText = '';
      if (langDict && langDict.res_box_text) {
        acpText = stripHtml(langDict.res_box_text);
      } else {
        const acpHost = doc.querySelector('[data-translate="res_box_text"]') ||
                        doc.querySelector('#anaerobic-respiration p') ||
                        doc.querySelector('section .text-xs.text-gray-700');
        acpText = acpHost?.textContent || '';
      }
      const acpMatch = acpText.match(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*%/);
      if (acpMatch) result.o2Acp = `${acpMatch[1].replace(',', '.')}% - ${acpMatch[2].replace(',', '.')}%`;

      return result;
    };

    // Did a parse pass actually find anything worth importing?
    const productSheetHasData = (r) =>
      !!(r && (r.defects.length > 0 || r.o2Target || r.co2Target || r.tempCritical || r.o2Acp || r.co2Max));

    // Two sheet generations are in circulation: the pre-2026 .htm sheets
    // and the 2026 template written by the perfotec-product-sheet skill.
    // Detect which one we have, and fall back to the other generation when
    // the expected one yields nothing — so a hybrid or hand-edited sheet
    // still imports instead of failing outright.
    const parseProductSheet = (htmlText, targetLang) => {
      const result = { defects: [], o2Target: '', co2Target: '', tempCritical: '', o2Acp: '', co2Max: '', ethyleneProfile: '' };
      if (!htmlText || typeof htmlText !== 'string') return result;
      try {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const wanted = targetLang || 'nl';
        const isV2 = !!(doc.querySelector('.defect-card') || doc.querySelector('td.t-target') || doc.querySelector('.card-eyebrow'));

        if (isV2) {
          parseProductSheetV2(doc, wanted, result);
          if (!productSheetHasData(result)) parseProductSheetV1(doc, htmlText, wanted, result);
        } else {
          parseProductSheetV1(doc, htmlText, wanted, result);
          if (!productSheetHasData(result)) parseProductSheetV2(doc, wanted, result);
        }
      } catch (e) {
        // Parsing failed — return whatever we got. Caller will alert user.
      }
      return result;
    };

    /* ======================================================================
     * PRODUCT DATABASE
     * ==================================================================== */

    // Standalone export in the dashboard's own folder. Only a fallback: it is
    // no longer the live store, but it keeps the forms usable when they are
    // opened outside the PerfoTec server (no folder bound).
    var LEGACY_DB_URL = '../Product%20Dashboard%20-%20PerfoTec/PerfoTec_Database.json';

    // The dashboard keeps its defects & prevention matrix as flat, indexed keys
    // on the R&D data task rather than as a list: defect_0_name, defect_0_cause,
    // defect_0_mhp, defect_0_map, … with defectCount saying how many rows the
    // editor shows. Rows left completely blank are skipped.
    function readDefectMatrix(core4) {
        var out = [];
        var count = parseInt(core4.defectCount, 10);
        if (!count || count < 1) count = 7;          // the dashboard's own default
        for (var i = 0; i < count; i++) {
            var defect = (core4['defect_' + i + '_name'] || '').trim();
            var cause = (core4['defect_' + i + '_cause'] || '').trim();
            var mhp = (core4['defect_' + i + '_mhp'] || '').trim();
            var map = (core4['defect_' + i + '_map'] || '').trim();
            if (!defect && !cause && !mhp && !map) continue;
            out.push({ id: Date.now() + i, defect: defect, cause: cause, effectMHP: mhp, effectMAP: map });
        }
        return out;
    }

    // Flatten a stored product record into what a form needs. Everything the
    // dashboard validated through trials lives under formData.
    function normaliseProduct(p) {
        var fd = p.formData || {};
        var core1 = fd['p1-core-1'] || {};
        var core3 = fd['p1-core-3'] || {};
        var core4 = fd['p1-core-4'] || {};
        var sheet = fd['product-sheet'] || {};
        var label = [p.name, p.variety].filter(Boolean).join(' ').trim() || p.name || '—';
        return {
            id: p.id,
            label: label,
            name: p.name || '',
            variety: p.variety || '',
            state: p.state || '',
            hasSheet: !!sheet.html,
            sheetHtml: sheet.html || '',
            sheetFileName: sheet.fileName || '',
            acp: core1.acp, critCO2: core1.critCO2,
            o2Min: core3.targetO2Min, o2Max: core3.targetO2Max,
            co2Min: core3.targetCO2Min, co2Max: core3.targetCO2Max,
            tempMin: core3.storageTempMin, tempMax: core3.storageTempMax,
            // The dashboard's own matrix, filled in from trials. Outranks the
            // one in an attached sheet, which holds the original research.
            defects: readDefectMatrix(core4)
        };
    }

    // "All varieties" is a read-only aggregate in the dashboard, never a real
    // product — it has no data of its own to offer.
    function usableProducts(list) {
        return (list || [])
            .filter(function (p) { return p && p.id && !p.isAverage; })
            .map(normaliseProduct)
            .sort(function (a, b) {
                if (a.hasSheet !== b.hasSheet) return a.hasSheet ? -1 : 1;
                return a.label.localeCompare(b.label);
            });
    }

    // Read the product database: the shared folder first (the live store), the
    // standalone export second. Resolves to [] when neither is reachable.
    function loadProducts() {
        var B = window.PerfoTecBoard;
        var viaFile = function () {
            return fetch(LEGACY_DB_URL, { cache: 'no-store' }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function (data) {
                return usableProducts(data && data.products);
            }).catch(function () { return []; });
        };
        if (!B || !B.isSupported()) return viaFile();
        return B.permissionState().then(function (state) {
            if (state !== 'granted') return viaFile();
            return B.readAllProducts().then(function (records) {
                return records.length > 0 ? usableProducts(records) : viaFile();
            });
        }).catch(viaFile);
    }

    // Parse a database export the user picked by hand (file:// fallback).
    function readBackupFile(file) {
        return file.text().then(function (txt) {
            return usableProducts(JSON.parse(txt).products);
        });
    }

    /* ======================================================================
     * MATCHING & CREATION
     * ==================================================================== */

    function normName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    // Does this typed name correspond to a product in the list? Compares on
    // letters and digits only, so "Bimi®Broccolini" and "bimi broccolini" are
    // the same product. Full label first, then the bare name.
    function matchProduct(name, list) {
        var want = normName(name);
        if (!want) return null;
        var byLabel = null, byName = null;
        (list || []).forEach(function (p) {
            if (!byLabel && normName(p.label) === want) byLabel = p;
            if (!byName && normName(p.name) === want) byName = p;
        });
        return byLabel || byName || null;
    }

    // Add a product to the shared database and return it normalised. Requires a
    // bound folder; rejects with code NO_STORE when there is none, so the form
    // can explain rather than fail silently.
    function createProduct(prod) {
        var B = window.PerfoTecBoard;
        if (!B || !B.isSupported()) {
            var e = new Error('No product store'); e.code = 'NO_STORE';
            return Promise.reject(e);
        }
        return B.permissionState().then(function (state) {
            if (state === 'granted') return true;
            return B.requestAccess();
        }).then(function (ok) {
            if (!ok) { var e2 = new Error('No product store'); e2.code = 'NO_STORE'; throw e2; }
            return B.readProductIndex();
        }).then(function (idx) {
            var record = B.newProductRecord(prod, (idx.products || []).map(function (p) { return p.id; }));
            return B.writeProduct(record).then(function () { return normaliseProduct(record); });
        });
    }

    /* ======================================================================
     * APPLYING A PRODUCT TO A FORM
     * ==================================================================== */

    // "3.0% - 5.0%" from a min/max pair, or a single value when only one side
    // is known.
    function range(min, max, unit) {
        var a = (min === undefined || min === null || min === '') ? null : String(min);
        var b = (max === undefined || max === null || max === '') ? null : String(max);
        if (a === null && b === null) return '';
        if (a !== null && b !== null && a !== b) return a + unit + ' - ' + b + unit;
        return (a === null ? b : a) + unit;
    }

    // Which product is this trial about? Every form stores at least these.
    function identityPatch(prod) {
        return {
            productName: prod.name || '',
            productId: prod.id,
            processingType: prod.state === 'processed' ? 'Processed' : 'Whole',
            // The chosen product's own variety wins, empty included — keeping the
            // previous one would carry another product's variety over.
            type: prod.variety || ''
        };
    }

    // Every field the product characteristics block holds, blanked. Used when the
    // form stops pointing at a known product, so one product's window can never
    // linger under another product's name.
    function emptyTargetPatch() {
        return {
            o2Target: '', co2Target: '', tempMin: '',
            acpO2: '', co2Max: '', ethyleneProfile: '',
            defectsMatrix: []
        };
    }

    // The operating window, for the forms that carry those fields (proposal and
    // report; intake has none). Dashboard numbers are trial-validated, so they
    // outrank the sheet's research values, and the sheet supplies what the
    // dashboard has no field for — the defects matrix and the ethylene profile.
    //
    // This REPLACES the whole block; it never merges with what was already in the
    // form. An earlier version fell back to the previous values for anything this
    // product left empty, which quietly carried one product's data over to the
    // next: selecting Bimi®Broccolini and then Apple left Apple showing
    // broccolini defects. There is no way to tell "typed by the user for this
    // product" from "left over from another product", so a product's block is
    // all-or-nothing. Fields this product has no data for come back empty.
    function targetPatch(prod, lang) {
        var parsed = prod.sheetHtml ? parseProductSheet(prod.sheetHtml, lang) : null;
        var o2 = range(prod.o2Min, prod.o2Max, '%');
        var co2 = range(prod.co2Min, prod.co2Max, '%');
        var temp = range(prod.tempMin, prod.tempMax, '°C');
        var acp = (prod.acp === undefined || prod.acp === null || prod.acp === '') ? '' : prod.acp + '%';
        var crit = (prod.critCO2 === undefined || prod.critCO2 === null || prod.critCO2 === '') ? '' : prod.critCO2 + '%';

        // Same order of authority as the numbers above: what the dashboard holds
        // is trial-validated and wins; an attached sheet fills the gap when the
        // dashboard's matrix is still empty.
        var fromDash = prod.defects || [];
        var fromSheet = (parsed && parsed.defects) || [];
        var defects = fromDash.length ? fromDash : fromSheet;
        var source = fromDash.length ? 'dashboard' : (fromSheet.length ? 'sheet' : 'none');

        return {
            patch: {
                o2Target: o2 || (parsed && parsed.o2Target) || '',
                co2Target: co2 || (parsed && parsed.co2Target) || '',
                tempMin: temp || (parsed && parsed.tempCritical) || '',
                acpO2: acp || (parsed && parsed.o2Acp) || '',
                co2Max: crit || (parsed && parsed.co2Max) || '',
                ethyleneProfile: (parsed && parsed.ethyleneProfile) || '',
                defectsMatrix: defects
            },
            defectCount: defects.length,
            defectSource: source
        };
    }

    window.PerfoTecProduct = {
        // Product sheets
        parseSheet: parseProductSheet,
        sheetHasData: productSheetHasData,
        // Product database
        LEGACY_DB_URL: LEGACY_DB_URL,
        loadProducts: loadProducts,
        readBackupFile: readBackupFile,
        normaliseProduct: normaliseProduct,
        usableProducts: usableProducts,
        // Selection
        matchProduct: matchProduct,
        createProduct: createProduct,
        identityPatch: identityPatch,
        targetPatch: targetPatch,
        emptyTargetPatch: emptyTargetPatch,
        range: range
    };
})();

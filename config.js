/**
 * ============================================================================
 * PERFOTEC GLOBAL CONFIGURATION (config.js) — v2.1
 * ============================================================================
 * Based on: PerfoTec Brand Guidelines (V 1.0, 2023)
 * Shared constants, brand rules and settings for the PerfoTec Hub, Intake,
 * Proposal and Report tools.
 *
 * CHANGELOG v2.1
 *   - SCHEMA_VERSION added (tracks JSON payload shape, independent of app code)
 *   - extractPrimaryContact() — canonical contacts[] -> flat primary fields
 *   - buildContactsArray()   — inverse, rebuilds contacts[] for export round-trip
 *   - normalizeProduct()     — aliases trialTarget <-> legacy targetGoal
 *   - migrateSchema()        — one-shot backward-compat wrapper for importers
 *   - getI18nLabel()         — centralised i18n label lookup
 *   - UI_CLASSES             — shared Tailwind strings for input/label
 *   - Flat PACKAGING_TYPES / TRANSPORT_MODES / DEFAULT_CRITERIA arrays removed
 *     (callers now derive flat arrays from the *_I18N sources)
 *   - Source comments translated to English (primary code language)
 *
 * CHANGELOG v2.0
 *   - Favicon path & meta info added
 *   - APP_VERSION constant added
 *   - applyMetaTags() helper for consistent <head> tags across pages
 */

window.PERFOTEC_CONFIG = {
    // === 0. APP META ===
    APP_VERSION: '2.1.0',

    // NOTE: this file is PUBLIC — it ships with the app to GitHub Pages. Never
    // put credentials, webhook URLs or tokens here, and do not add a secrets file
    // alongside it either: none of these pages sends data anywhere, and that is
    // deliberate. A page served from a public URL cannot keep a secret, so any
    // endpoint baked in here is callable by anyone who views the source.

    // SCHEMA_VERSION tracks the exported JSON shape. Bump this when the
    // structure of exported data changes in a way importers need to migrate.
    SCHEMA_VERSION: '2.1',

    META: {
        favicon: 'https://cdn.prod.website-files.com/68b594c756c22085ddc6c1ea/68b59ba2f027bfeecd25261b_PerfoTec%20logo.png',
        description: 'PerfoTec Management Hub — Tools for quality testing, trial proposals, and official reporting.',
        author: 'PerfoTec B.V.',
        themeColor: '#008837'
    },

    // === 1. BRANDING & STYLING (PerfoTec Brand Guidelines v2.0) ===
    // Values come from perfotec-brand-tokens.json v2.0. The 2023 identity that
    // used to live here — #007C27 green, #054E9A blue, League Spartan + Inter —
    // is retired; brand.js carries the same palette into Tailwind, and style.css
    // into CSS custom properties. All three must stay in step.
    BRAND: {
        name: 'PerfoTec',
        tagline: 'BEST FOR FRESHNESS',
        logos: {
            // The full lockup: wordmark plus tagline. The guide forbids splitting
            // the two, so the shorter wordmark-only file the website uses in its
            // own navigation is not an option here.
            default: 'https://cdn.prod.website-files.com/68b594c756c22085ddc6c1ea/68b59ba2f027bfeecd25261b_PerfoTec%20logo.png',
            icon: '',
            reverse: ''
        },
        colors: {
            primary: {
                green: '#008837',      // brand; contact & sustainability
                blue: '#084BCD',       // primary action
                darkBlue: '#073DA6'    // hover / pressed on primary
            },
            secondary: {
                lightBlue: '#5A85E7',
                orange: '#ea580c'
            },
            neutral: {
                black: '#1A1B1F',      // Ink — display headings
                charcoal: '#333333',   // body text
                muted: '#8A97AD',      // captions, eyebrow labels
                gray: '#E4EBF3',       // Cool Gray — borders, dividers
                lightGray: '#F7F7F7',  // Mist — section backgrounds
                blueTint: '#F1F6FF',   // soft tech section backgrounds
                white: '#FFFFFF'
            }
        },
        fonts: {
            heading: '"Montserrat", Arial, "Helvetica Neue", Helvetica, sans-serif',
            body: '"Montserrat", Arial, "Helvetica Neue", Helvetica, sans-serif'
        }
    },

    // Series colours for the trial charts, repainted onto the v2.0 palette.
    // The order is deliberately unchanged: a variant that was the green line in
    // last month's report stays the green line in this month's, so two reports
    // side by side still compare. Fills are the matching light tint from the
    // same ramps brand.js installs into Tailwind.
    CHART_COLORS: [
        { stroke: '#008837', fill: '#EDF8F2', name: 'PerfoTec Green' },
        { stroke: '#084BCD', fill: '#F1F6FF', name: 'PerfoTec Blue' },
        { stroke: '#1A1B1F', fill: '#F2F5F9', name: 'PerfoTec Ink' },
        { stroke: '#5A85E7', fill: '#E0EAFF', name: 'Light Blue Accent' },
        { stroke: '#00A346', fill: '#D0F0DE', name: 'Light Green Accent' }
    ],

    // === 1b. SHARED UI CLASS STRINGS (Tailwind) ===
    // Single source of truth for input/label classes across Intake, Proposal,
    // and Report. Pages alias these into their local `inputClass` / `labelClass`
    // constants so per-field overrides (e.g. `${inputClass} focus:ring-green-500`)
    // continue to work unchanged.
    // The colours here are Tailwind names, and brand.js has remapped those names
    // onto the v2.0 palette — `border-slate-200` is Cool Gray #E4EBF3, `blue-600`
    // is PerfoTec Blue, `rounded-lg` is the guide's 8px. The label recipe is the
    // eyebrow treatment perfotec.com puts above its own blocks: small, SemiBold,
    // uppercase, tracked wide, in the muted grey rather than heavy charcoal.
    UI_CLASSES: {
        input: 'w-full bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg focus:ring-2 focus:ring-blue-600/25 focus:border-blue-600 block p-3 shadow-sm transition-all hover:border-slate-300 focus:bg-white',
        label: 'block mb-2 text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase'
    },

    // === 2. DROPDOWN OPTIONS (with i18n) ===
    // The *_I18N arrays below are the single source of truth. Each entry has a
    // canonical `value` (English, used in state and JSON) and a localised
    // `label` per language. Callers that need a flat list of values derive it
    // on load:  `I18N_ARRAY.map(x => x.value)`.
    PACKAGING_TYPES_I18N: [
        { value: 'Punnets',     label: { en: 'Punnets',     nl: 'Bakjes',         es: 'Bandejas' } },
        { value: 'Pillow Bag',  label: { en: 'Pillow Bag',  nl: 'Zak',            es: 'Bolsa' } },
        { value: 'Box/ Crate',  label: { en: 'Box/ Crate',  nl: 'Doos/ Krat',     es: 'Caja' } },
        { value: 'Cube crate',  label: { en: 'Cube crate',  nl: 'Kubuskrat',      es: 'Cajón cúbico' } },
        { value: 'Pallet',      label: { en: 'Pallet',      nl: 'Pallet',         es: 'Palé' } }
    ],
    TRANSPORT_MODES_I18N: [
        { value: 'Air Freight',    label: { en: 'Air Freight',     nl: 'Luchtvracht',    es: 'Transporte Aéreo' } },
        { value: 'Sea Freight',    label: { en: 'Sea Freight',     nl: 'Zeevracht',      es: 'Transporte Marítimo' } },
        { value: 'Road Transport', label: { en: 'Road Transport',  nl: 'Wegtransport',   es: 'Transporte Terrestre' } },
        { value: 'Storage',        label: { en: 'Storage',         nl: 'Opslag',         es: 'Almacenamiento' } }
    ],

    // === 3. QUALITY & SUPPLY CHAIN ===
    // Criteria use the same *_I18N-is-source pattern as packaging/transport above.
    PERFOTEC_TECHNOLOGIES_I18N: [
        { value: 'Respiration Measurement (FRM)',  label: { en: 'Respiration Measurement (FRM)',  nl: 'Respiratie Meting (FRM)',         es: 'Medición de Respiración (FRM)' } },
        { value: 'Laser Micro Perforation',        label: { en: 'Laser Micro Perforation',        nl: 'Laser Micro Perforatie',          es: 'Microperforación Láser' } },
        { value: 'Laser Nano Perforation',         label: { en: 'Laser Nano Perforation',         nl: 'Laser Nano Perforatie',           es: 'Nanoperforación Láser' } },
        { value: 'Gas Flush (O2 Control)',         label: { en: 'Gas Flush (O2 Control)',         nl: 'Gas Doorspoeling (O2 Controle)',  es: 'Enjuague de Gas (Control O2)' } },
        { value: 'CO2 Shock',                      label: { en: 'CO2 Shock',                      nl: 'CO2 Shock',                        es: 'Choque de CO2' } },
        { value: 'PerfoTec Retail Film',           label: { en: 'PerfoTec Retail Film',           nl: 'PerfoTec Retail Folie',            es: 'Película Retail PerfoTec' } },
        { value: 'PerfoTec Liner',                 label: { en: 'PerfoTec Liner',                 nl: 'PerfoTec Liner',                   es: 'Forro PerfoTec' } },
        { value: 'PerfoTec Pallet Cover',          label: { en: 'PerfoTec Pallet Cover',          nl: 'PerfoTec Palletafdekking',         es: 'Cubierta de Palé PerfoTec' } }
    ],

    DEFAULT_CRITERIA_I18N: [
        { value: 'General Quality',        label: { en: 'General Quality',        nl: 'Algemene Kwaliteit',     es: 'Calidad General' } },
        { value: 'Taste',                  label: { en: 'Taste',                  nl: 'Smaak',                  es: 'Sabor' } },
        { value: 'Visual Appearance',      label: { en: 'Visual Appearance',      nl: 'Visueel Uiterlijk',      es: 'Apariencia Visual' } },
        { value: 'Color',                  label: { en: 'Color',                  nl: 'Kleur',                  es: 'Color' } },
        { value: 'Smell / Aroma',          label: { en: 'Smell / Aroma',          nl: 'Geur / Aroma',           es: 'Olor / Aroma' } },
        { value: 'Texture / Firmness',     label: { en: 'Texture / Firmness',     nl: 'Textuur / Stevigheid',   es: 'Textura / Firmeza' } },
        { value: 'Humidity / Condensation', label: { en: 'Humidity / Condensation', nl: 'Vocht / Condens',       es: 'Humedad / Condensación' } },
        { value: 'Dehydration / Shriveling', label: { en: 'Dehydration / Shriveling', nl: 'Uitdroging / Verschrompeling', es: 'Deshidratación / Arrugamiento' } },
        { value: 'Moulds / Decay',         label: { en: 'Moulds / Decay',         nl: 'Schimmel / Bederf',      es: 'Moho / Descomposición' } },
        { value: 'Internal Browning',      label: { en: 'Internal Browning',      nl: 'Interne Verbruining',    es: 'Pardeamiento Interno' } }
    ],
    DEFAULT_SUPPLY_CHAIN: [
        { stage: 'Farm / Harvest', tempStart: '15', tempEnd: '', daysStart: '0.5', daysEnd: '', action: 'none' },
        { stage: 'Packing House', tempStart: '12', tempEnd: '', daysStart: '1', daysEnd: '', action: 'pack' },
        { stage: 'Transport', tempStart: '6', tempEnd: '', daysStart: '2', daysEnd: '', action: 'none' },
        { stage: 'Distribution Center', tempStart: '4', tempEnd: '', daysStart: '1', daysEnd: '', action: 'none' },
        { stage: 'Retail Store', tempStart: '18', tempEnd: '', daysStart: '4', daysEnd: '', action: 'none' },
        { stage: 'Consumer', tempStart: '20', tempEnd: '', daysStart: '2', daysEnd: '', action: 'unpack' }
    ],
    // Supply-chain stage translations (canonical value -> localised label)
    SUPPLY_CHAIN_LABELS: {
        'Farm / Harvest':       { en: 'Farm / Harvest',       nl: 'Boerderij / Oogst',      es: 'Granja / Cosecha' },
        'Packing House':        { en: 'Packing House',        nl: 'Verpakkingshuis',        es: 'Empacadora' },
        'Transport':            { en: 'Transport',            nl: 'Transport',              es: 'Transporte' },
        'Distribution Center':  { en: 'Distribution Center',  nl: 'Distributiecentrum',     es: 'Centro de Distribución' },
        'Retail Store':         { en: 'Retail Store',         nl: 'Winkel',                 es: 'Tienda' },
        'Consumer':             { en: 'Consumer',             nl: 'Consument',              es: 'Consumidor' },
        'Transport by road':    { en: 'Transport by road',    nl: 'Wegtransport',           es: 'Transporte Terrestre' },
        'Seafreight':           { en: 'Seafreight',           nl: 'Zeevracht',              es: 'Transporte Marítimo' },
        'Airfreight':           { en: 'Airfreight',           nl: 'Luchtvracht',            es: 'Transporte Aéreo' },
        'Storage':              { en: 'Storage',              nl: 'Opslag',                 es: 'Almacenamiento' }
    },
    /**
     * Look up a localised label in one of the *_I18N arrays.
     * @param {Array<{value:string,label:{[lang]:string}}>} i18nArr
     * @param {string} value - the canonical (English) value stored in state/JSON
     * @param {string} lang - 'en' | 'nl' | 'es'
     * @returns the translated label, or the original value as a safe fallback.
     */
    getI18nLabel: function(i18nArr, value, lang) {
        if (!i18nArr) return value;
        const item = i18nArr.find(x => x.value === value);
        if (item && item.label && item.label[lang]) return item.label[lang];
        return value;
    },

    // Return the translated label for a stored canonical value.
    translateLabel: function(value, lang) {
        if (!value) return value;
        const l = lang || this.getLanguage();
        if (this.SUPPLY_CHAIN_LABELS[value] && this.SUPPLY_CHAIN_LABELS[value][l]) {
            return this.SUPPLY_CHAIN_LABELS[value][l];
        }
        return value;
    },

    /**
     * Re-translate a supply-chain stage label when the UI language changes.
     *
     * The intake/proposal tools store the *display* string (already translated)
     * in supplyChain[i].stage. When the user toggles EN/NL/ES we must map the
     * current value back to its canonical key and emit the label for the new
     * language. Free-text stages entered by the user (no canonical match) are
     * returned unchanged so we never overwrite custom input.
     */
    retranslateStage: function(value, targetLang) {
        if (!value) return value;
        const t = targetLang || this.getLanguage();
        // Find the canonical (English) key whose translations include the
        // current value in any language.
        for (const canonical in this.SUPPLY_CHAIN_LABELS) {
            const variants = this.SUPPLY_CHAIN_LABELS[canonical];
            for (const lng in variants) {
                if (variants[lng] === value) {
                    return variants[t] || canonical;
                }
            }
        }
        // Not a canonical stage — user-edited free text, leave untouched.
        return value;
    },

    // === 3b. UNIT HELPERS (metric <-> imperial) ===
    UNIT_LABELS: {
        metric:   { length: 'mm', lengthBulk: 'cm', weight: 'g', weightBulk: 'kg', temp: '°C' },
        imperial: { length: 'in', lengthBulk: 'in', weight: 'oz', weightBulk: 'lb', temp: '°F' }
    },
    // Get the unit label for a given dimension and unit system.
    getUnitLabel: function(type, unitSystem, isBulk) {
        const sys = (unitSystem === 'imperial') ? 'imperial' : 'metric';
        const labels = this.UNIT_LABELS[sys];
        if (type === 'length') return isBulk ? labels.lengthBulk : labels.length;
        if (type === 'weight') return isBulk ? labels.weightBulk : labels.weight;
        if (type === 'temp') return labels.temp;
        return '';
    },
    // Convert a value between metric and imperial systems.
    // type: 'length' | 'weight' | 'temp'; isBulk: true for large/bulk packaging.
    convertValue: function(value, type, isBulk, toImperial) {
        const v = parseFloat(value);
        if (isNaN(v)) return value;
        let result = v;
        if (type === 'length') {
            // metric mm <-> imperial inch (bulk: cm <-> inch)
            if (isBulk) {
                result = toImperial ? v / 2.54 : v * 2.54;
            } else {
                result = toImperial ? v / 25.4 : v * 25.4;
            }
        } else if (type === 'weight') {
            if (isBulk) {
                result = toImperial ? v * 2.20462 : v / 2.20462; // kg <-> lb
            } else {
                result = toImperial ? v * 0.035274 : v / 0.035274; // g <-> oz
            }
        } else if (type === 'temp') {
            result = toImperial ? (v * 9/5) + 32 : (v - 32) * 5/9;
        }
        return Number(result.toFixed(2)).toString();
    },

    // === 4. RATING SCALES ===
    SCORES: [
        [10, 'excellent – exceptionally appealing quality, exceptional good'],
        [9, 'very good – natural quality of the product, full strong characteristic quality attributes'],
        [8, 'good – natural quality, with few specimens with slightly light impairment'],
        [7, 'commendable – natural quality, with several specimens with light impairment'],
        [6, 'satisfactory – slightly reduced quality attributes'],
        [5, 'unacceptable – impairment of natural quality attributes'],
        [4, 'beyond unacceptable – clear impairment of quality attributes'],
        [3, 'poor – generally severe loss of quality, no longer appealing'],
        [2, 'bad – strong and severe quality loss, strongly unpleasant'],
        [1, 'very bad – complete quality decay, spoiled and repulsive']
    ],
    MINI_SCORES: [
        [10, 'Excellent', 'text-green-700'],
        [8, 'Good', 'text-green-600'],
        [6, 'Satisfactory', 'text-yellow-600'],
        [4, 'Unacceptable', 'text-red-600'],
        [1, 'Very Bad', 'text-red-800']
    ],

    // === 5. LANGUAGE MANAGEMENT ===
    LANGUAGES: [
        { code: 'en', label: 'EN' },
        { code: 'nl', label: 'NL' },
        { code: 'es', label: 'ES' }
    ],

    getLanguage: function() {
        const savedLang = localStorage.getItem('perfotec_lang');
        if (savedLang && this.LANGUAGES.find(l => l.code === savedLang)) return savedLang;
        if (typeof navigator !== 'undefined') {
            const browserLang = (navigator.language || navigator.userLanguage || '').substring(0, 2).toLowerCase();
            if (this.LANGUAGES.find(l => l.code === browserLang)) return browserLang;
        }
        return 'en';
    },

    setLanguage: function(code) {
        if (this.LANGUAGES.find(l => l.code === code)) {
            localStorage.setItem('perfotec_lang', code);
            return true;
        }
        return false;
    },

    // === 6. CENTRAL JSON LOGIC (Import / Export "Save As") ===
    exportJSON: async function(data, defaultFilename) {
        const dataString = JSON.stringify(data, null, 2);

        if (window.showSaveFilePicker) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: defaultFilename,
                    types: [{
                        description: 'JSON File',
                        accept: { 'application/json': ['.json'] },
                    }],
                });
                const writable = await fileHandle.createWritable();
                await writable.write(dataString);
                await writable.close();
                return;
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error("Save As dialog failed, falling back to direct download...", err);
            }
        }

        const blob = new Blob([dataString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    importJSON: function(file, successCallback, errorCallback) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                if (successCallback) successCallback(data);
            } catch (err) {
                if (errorCallback) errorCallback(err);
            }
        };
        reader.readAsText(file);
    },

    // === 7. SCHEMA HELPERS (v2.1) ===
    //
    // Canonical JSON shape:
    //   client.contacts[]  — array of { id, name, role, email, phoneDirect, phoneWork }
    //   products[*].trialTarget  — canonical name (legacy: targetGoal)
    //
    // Proposal/Report carry a *flat* primary contact in their React state
    // (contactName, role, email, phone, phoneDirect, phoneWork) for display
    // ergonomics, while still storing the full contacts[] array so round-trips
    // preserve every contact. These helpers bridge the two shapes.

    /**
     * Return a flat primary-contact projection from a client object.
     * Accepts either the canonical contacts[] array (intake exports) or
     * legacy flat fields. Always returns the full contacts[] alongside the
     * flat projection so callers can preserve it.
     */
    extractPrimaryContact: function(client) {
        const empty = {
            contactName: '', role: '', email: '',
            phone: '', phoneDirect: '', phoneWork: '',
            contacts: []
        };
        if (!client || typeof client !== 'object') return empty;

        if (Array.isArray(client.contacts) && client.contacts.length > 0) {
            const c = client.contacts[0] || {};
            return {
                contactName: c.name || '',
                role: c.role || '',
                email: c.email || '',
                phone: c.phoneDirect || c.phoneWork || c.phone || '',
                phoneDirect: c.phoneDirect || '',
                phoneWork: c.phoneWork || '',
                contacts: client.contacts
            };
        }

        // Legacy / flat fallback
        return {
            contactName: client.contactName || '',
            role: client.role || '',
            email: client.email || '',
            phone: client.phone || client.phoneDirect || client.phoneWork || '',
            phoneDirect: client.phoneDirect || '',
            phoneWork: client.phoneWork || '',
            contacts: (Array.isArray(client.contacts) && client.contacts.length > 0) ? client.contacts : [{ id: 1, name: client.contactName || '', role: client.role || '', email: client.email || '', phoneDirect: client.phoneDirect || client.phone || '', phoneWork: client.phoneWork || '' }]
        };
    },

    /**
     * Rebuild a canonical contacts[] array from clientInfo for JSON export.
     *
     * Source-of-truth rule: when clientInfo.contacts is a non-empty array
     * (set by any multi-contact UI), trust it as-is. The flat primary-contact
     * fields on clientInfo (`contactName`, `role`, `email`, `phone`,
     * `phoneDirect`, `phoneWork`) are *shadow* state — proposal/report seed
     * them from contacts[0] on import for legacy preview rendering, but the
     * multi-contact UI never writes back into them. Letting those stale
     * shadow values leak into buildContactsArray would silently overwrite
     * user edits to contacts[0].
     *
     * Legacy fallback: when contacts[] is missing/empty, build a single
     * primary entry from the flat fields so old exports without a
     * contacts[] array still round-trip.
     */
    buildContactsArray: function(clientInfo) {
        if (!clientInfo || typeof clientInfo !== 'object') return [];
        const existing = Array.isArray(clientInfo.contacts) ? clientInfo.contacts : [];

        // Treat a contact as "real" when it has any non-blank field. The seed
        // entry the multi-contact UI starts with is `{id, name:'', ...}` —
        // exporting that would silently overwrite a previously-saved primary
        // and cause the imported JSON to look "missing" the contact.
        const isFilled = (c) => !!(c && (c.name || c.role || c.email || c.phoneDirect || c.phoneWork));

        if (existing.length > 0) {
            // Drop blank seeds anywhere in the array (including slot 0 when
            // there are non-empty entries after it). This matches user
            // intent: they only see filled cards, so only filled cards round-
            // trip to JSON.
            const filled = existing.filter(isFilled);
            if (filled.length > 0) return filled;
            // Whole list is empty seeds — nothing to round-trip.
            return [];
        }

        // Legacy: tools that only expose a flat primary-contact UI build a
        // one-element contacts[] array from those flat fields.
        const primary = {
            id: 1,
            name: clientInfo.contactName || '',
            role: clientInfo.role || '',
            email: clientInfo.email || '',
            phoneDirect: clientInfo.phoneDirect || clientInfo.phone || '',
            phoneWork: clientInfo.phoneWork || ''
        };
        return isFilled(primary) ? [primary] : [];
    },

    /**
     * Normalise a product object so both legacy and canonical field names are
     * present. Currently aliases: trialTarget <-> targetGoal (canonical
     * trialTarget). Never mutates the input.
     */
    normalizeProduct: function(prod) {
        if (!prod || typeof prod !== 'object') return prod;
        const out = { ...prod };
        if (out.trialTarget == null && out.targetGoal != null) out.trialTarget = out.targetGoal;
        if (out.targetGoal == null && out.trialTarget != null) out.targetGoal = out.trialTarget;
        // Legacy packaging consolidation: "Bin crate" merged into "Cube crate"
        // (v2.1 onward they refer to the same packaging type).
        if (out.packagingType === 'Bin crate') out.packagingType = 'Cube crate';
        return out;
    },

    /**
     * One-shot migration wrapper for importers. Returns a new object with:
     *   - schemaVersion populated (defaults to "1.0" when missing)
     *   - client.contacts[] back-filled from flat legacy fields when needed
     *   - products[*] normalised via normalizeProduct()
     *
     * Never mutates the input. Safe to call on intake, proposal and report
     * payloads — fields that are absent are simply passed through.
     */
    migrateSchema: function(raw) {
        if (!raw || typeof raw !== 'object') return raw;
        const data = { ...raw };
        data.schemaVersion = raw.schemaVersion || '1.0';

        if (data.client && typeof data.client === 'object') {
            const cl = { ...data.client };
            const hasArray = Array.isArray(cl.contacts) && cl.contacts.length > 0;
            if (!hasArray) {
                const hasFlat = cl.contactName || cl.email || cl.phone || cl.phoneDirect || cl.phoneWork || cl.role;
                cl.contacts = hasFlat ? [{
                    id: 1,
                    name: cl.contactName || '',
                    role: cl.role || '',
                    email: cl.email || '',
                    phoneDirect: cl.phoneDirect || cl.phone || '',
                    phoneWork: cl.phoneWork || ''
                }] : [{ id: 1, name: '', role: '', email: '', phoneDirect: '', phoneWork: '' }];
            }
            data.client = cl;
        }

        if (Array.isArray(data.products)) {
            data.products = data.products.map(p => this.normalizeProduct(p));
        }

        return data;
    },

    // === 7c. IMAGE INTAKE (camera / file) ===
    /**
     * Sane defaults for photos that go into a report. 1600px on the long edge
     * keeps enough detail to judge mould, browning and condensation — these
     * photos are evidence, not decoration — and lands around 200-400 KB.
     */
    IMAGE_INTAKE: {
        maxEdge: 1600,
        quality: 0.8,
        // Below this, a file is left exactly as it is. Covers logos (often PNG
        // with transparency, which JPEG would flatten onto black) and anything
        // already small enough not to matter.
        skipBelowBytes: 400 * 1024
    },

    /**
     * Read an image File (camera capture or file pick) and return a downscaled
     * JPEG data URL, with the numbers needed to show the user what happened.
     *
     * Why this exists: photos went in at full size. A real trial report measured
     * 62.5 MB for 21 photos — 100% of the file, largest single photo 8.25 MB.
     * Phone cameras make that worse: a 12 MP shot is 3-12 MB and base64 adds
     * another third. Every autosave rewrites the whole phase file, so full-size
     * photos make the tool unusable on a phone and sluggish on a desktop.
     *
     * EXIF orientation matters here. Phone photos carry a rotation flag, and
     * drawing such a photo straight onto a canvas produces a sideways portrait.
     * createImageBitmap with imageOrientation 'from-image' applies the flag; the
     * <img> fallback leans on the browser doing it, which current browsers do.
     *
     * Never loses a photo: any failure resolves to the untouched original, so a
     * browser quirk costs bytes, not evidence.
     *
     * @param {File|Blob} file
     * @param {{maxEdge?:number, quality?:number, skipBelowBytes?:number}} [opts]
     * @returns {Promise<{dataUrl:string, width:number, height:number,
     *                    bytes:number, originalBytes:number, scaled:boolean}>}
     */
    readImageFile: function (file, opts) {
        const cfg = Object.assign({}, this.IMAGE_INTAKE, opts || {});
        const self = this;

        const asDataUrl = (blob) => new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error || new Error('read failed'));
            r.readAsDataURL(blob);
        });

        // Bytes of a data URL's payload, not of the base64 text.
        const payloadBytes = (dataUrl) => {
            const i = dataUrl.indexOf(',');
            if (i < 0) return dataUrl.length;
            const b64 = dataUrl.slice(i + 1);
            const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
            return Math.floor(b64.length * 3 / 4) - pad;
        };

        const untouched = (why) => asDataUrl(file).then(dataUrl => self.measureDataUrl(dataUrl).then(dim => ({
            dataUrl: dataUrl,
            width: dim.width,
            height: dim.height,
            bytes: payloadBytes(dataUrl),
            originalBytes: file.size || payloadBytes(dataUrl),
            scaled: false,
            reason: why
        })));

        if (!file || !/^image\//.test(file.type || '')) return untouched('not an image');

        // Small enough to leave alone, unless it is also oversized in pixels.
        const maybeSkip = (file.size && file.size < cfg.skipBelowBytes)
            ? asDataUrl(file).then(u => self.measureDataUrl(u).then(d =>
                (Math.max(d.width, d.height) <= cfg.maxEdge)
                    ? { skip: true, dataUrl: u, dim: d }
                    : { skip: false }))
            : Promise.resolve({ skip: false });

        return maybeSkip.then(pre => {
            if (pre.skip) return {
                dataUrl: pre.dataUrl,
                width: pre.dim.width,
                height: pre.dim.height,
                bytes: payloadBytes(pre.dataUrl),
                originalBytes: file.size,
                scaled: false,
                reason: 'already small'
            };

            return self.decodeImage(file).then(src => {
                const sw = src.width, sh = src.height;
                const scale = Math.min(1, cfg.maxEdge / Math.max(sw, sh));
                const w = Math.max(1, Math.round(sw * scale));
                const h = Math.max(1, Math.round(sh * scale));
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d');
                // White ground: a transparent PNG would otherwise flatten to black.
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(src, 0, 0, w, h);
                if (src.close) src.close();          // free the ImageBitmap
                const dataUrl = c.toDataURL('image/jpeg', cfg.quality);
                return {
                    dataUrl: dataUrl,
                    width: w,
                    height: h,
                    bytes: payloadBytes(dataUrl),
                    originalBytes: file.size || 0,
                    // Re-encoded, whether or not the pixel dimensions changed:
                    // a same-size JPEG pass still shrinks a 12 MP camera file.
                    scaled: true,
                    resized: (w !== sw || h !== sh)
                };
            }).catch(() => untouched('decode failed'));
        }).catch(() => untouched('read failed'));
    },

    /** Decode to something drawable, applying EXIF orientation where possible. */
    decodeImage: function (file) {
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(file, { imageOrientation: 'from-image' })
                .catch(() => this.decodeViaImgElement(file));
        }
        return this.decodeViaImgElement(file);
    },

    decodeViaImgElement: function (file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
            img.src = url;
        });
    },

    /** Pixel dimensions of a data URL, 0x0 when it cannot be decoded. */
    measureDataUrl: function (dataUrl) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve({ width: 0, height: 0 });
            img.src = dataUrl;
        });
    },

    /** "3.2 MB → 280 KB" for telling the user what the camera step did. */
    formatBytes: function (n) {
        if (!n && n !== 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    },

    // === 7b. PRINT / PDF EXPORT HELPER ===
    /**
     * Trigger the browser's native print dialog with a descriptive filename.
     *
     * Most browsers use `document.title` as the default "Save as PDF"
     * filename, so we swap the title just long enough to cover the print
     * dialog, then restore it on the `afterprint` event (with a timeout
     * safety net for browsers that do not fire it).
     *
     * @param {string} suggestedName - raw filename; sanitised to safe chars
     * @param {object} [options]     - reserved for future flags (page ranges etc.)
     */
    printWithFilename: function(suggestedName, options) {
        const safe = String(suggestedName || 'PerfoTec')
            .replace(/[^a-zA-Z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 120) || 'PerfoTec';
        const original = document.title;
        document.title = safe;
        const restore = () => {
            document.title = original;
            window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        // Safety net for browsers that skip afterprint (older Safari, some iOS).
        setTimeout(restore, 10000);
        window.print();
    },

    // === 8. HEAD META INJECTION HELPER ===
    /**
     * Inject favicon, meta-description, author and theme-color into <head>.
     * Auto-runs on script load, but can also be called manually.
     */
    applyMetaTags: function() {
        const head = document.head;
        if (!head) return;

        if (this.META.favicon && !document.querySelector('link[rel="icon"]')) {
            const link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/png';
            link.href = this.META.favicon;
            head.appendChild(link);
        }

        if (this.META.description && !document.querySelector('meta[name="description"]')) {
            const meta = document.createElement('meta');
            meta.name = 'description';
            meta.content = this.META.description;
            head.appendChild(meta);
        }

        if (this.META.themeColor && !document.querySelector('meta[name="theme-color"]')) {
            const meta = document.createElement('meta');
            meta.name = 'theme-color';
            meta.content = this.META.themeColor;
            head.appendChild(meta);
        }

        if (this.META.author && !document.querySelector('meta[name="author"]')) {
            const meta = document.createElement('meta');
            meta.name = 'author';
            meta.content = this.META.author;
            head.appendChild(meta);
        }
    }
};

// Auto-apply meta tags once the config is loaded.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.PERFOTEC_CONFIG.applyMetaTags());
} else {
    window.PERFOTEC_CONFIG.applyMetaTags();
}

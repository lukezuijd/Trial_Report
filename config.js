/**
 * ============================================================================
 * PERFOTEC GLOBALE CONFIGURATIE (config.js)
 * ============================================================================
 * Gebaseerd op: PerfoTec Brand Guidelines (V 1.0, 2023)
 * Dit bestand bevat alle gedeelde constanten, huisstijlregels en instellingen 
 * voor de PerfoTec Hub, Intake, Proposal en Report tools.
 */

window.PERFOTEC_CONFIG = {
    // === 1. BRANDING & STYLING (Conform Brand Guidelines) ===
    BRAND: {
        name: 'PerfoTec',
        tagline: 'BEST FOR FRESHNESS',
        logos: {
            default: 'https://cdn.prod.website-files.com/68b594c756c22085ddc6c1ea/68b59ba2f027bfeecd25261b_PerfoTec%20logo.png',
            icon: '', 
            reverse: '' 
        },
        colors: {
            primary: {
                green: '#007C27', 
                blue: '#054E9A',  
                darkBlue: '#004B87' 
            },
            secondary: {
                lightBlue: '#5B9BD5', 
                orange: '#ea580c'     
            },
            neutral: {
                black: '#211A1A',
                gray: '#E9E9E9',
                lightGray: '#F3F4F6',
                white: '#FFFFFF'
            }
        },
        fonts: {
            heading: '"League Spartan", sans-serif',
            body: '"Inter", sans-serif'
        }
    },

    CHART_COLORS: [
        { stroke: '#007C27', fill: '#dcfce7', name: 'PerfoTec Green' },
        { stroke: '#054E9A', fill: '#dbeafe', name: 'PerfoTec Blue' },
        { stroke: '#211A1A', fill: '#f3f4f6', name: 'PerfoTec Black' },
        { stroke: '#5B9BD5', fill: '#e0f2fe', name: 'Light Blue Accent' },
        { stroke: '#85B942', fill: '#ecfccb', name: 'Light Green Accent' }
    ],

    // === 2. DROPDOWN OPTIES ===
    PACKAGING_TYPES: [
        'Retail', 'Punnets', 'Pillow Bag', 'Box/ Crate', 'Bin crate', 'Cube crate', 'Pallet'
    ],
    TRANSPORT_MODES: [
        'Air Freight', 'Sea Freight', 'Road Transport', 'Storage'
    ],

    // === 3. KWALITEIT & SUPPLY CHAIN ===
    DEFAULT_CRITERIA: [
        'General Quality', 'Taste', 'Visual Appearance', 'Color',
        'Smell / Aroma', 'Texture / Firmness', 'Humidity / Condensation',
        'Dehydration / Shriveling', 'Moulds / Decay', 'Internal Browning'
    ],
    DEFAULT_SUPPLY_CHAIN: [
        { stage: 'Farm / Harvest', tempStart: '15', tempEnd: '', daysStart: '0.5', daysEnd: '', action: 'none' },
        { stage: 'Packing House', tempStart: '12', tempEnd: '', daysStart: '1', daysEnd: '', action: 'pack' },
        { stage: 'Transport', tempStart: '6', tempEnd: '', daysStart: '2', daysEnd: '', action: 'none' },
        { stage: 'Distribution Center', tempStart: '4', tempEnd: '', daysStart: '1', daysEnd: '', action: 'none' },
        { stage: 'Retail Store', tempStart: '18', tempEnd: '', daysStart: '4', daysEnd: '', action: 'none' },
        { stage: 'Consumer', tempStart: '20', tempEnd: '', daysStart: '2', daysEnd: '', action: 'unpack' }
    ],

    // === 4. BEOORDELINGSSCHALEN ===
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

    // === 5. TAAL BEHEER ===
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

    // === 6. CENTRALE JSON LOGICA (Import / Export "Save As") ===
    exportJSON: async function(data, defaultFilename) {
        const dataString = JSON.stringify(data, null, 2);
        
        // Probeer de moderne "Opslaan Als" (Save As) API te gebruiken in Chrome/Edge e.d.
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
                return; // Opslaan was succesvol via dialoog
            } catch (err) {
                // Als de gebruiker zelf op 'Annuleren' klikt, doe niets.
                if (err.name === 'AbortError') return;
                console.error("Save As dialog failed, falling back to direct download...", err);
            }
        }
        
        // Fallback (directe download) voor Safari, Firefox of als API geblokkeerd wordt
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
    }
};

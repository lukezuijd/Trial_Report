/**
 * ============================================================================
 * PERFOTEC GLOBALE CONFIGURATIE (config.js)
 * ============================================================================
 * Gebaseerd op: PerfoTec Brand Guidelines (V 1.0, 2023)
 * Dit bestand bevat alle gedeelde constanten, huisstijlregels en instellingen 
 * voor de PerfoTec Hub, Intake, Proposal en Report tools.
 * Gebruik in React (bijv): `window.PERFOTEC_CONFIG.BRAND.colors.primary.green`
 */

window.PERFOTEC_CONFIG = {
    // === 1. BRANDING & STYLING (Conform Brand Guidelines) ===
    BRAND: {
        name: 'PerfoTec',
        tagline: 'BEST FOR FRESHNESS',
        logos: {
            default: 'https://cdn.prod.website-files.com/68b594c756c22085ddc6c1ea/68b59ba2f027bfeecd25261b_PerfoTec%20logo.png',
            // Reserveringen voor de overige logotypes uit de brand guide
            icon: '', 
            reverse: '' 
        },
        colors: {
            primary: {
                green: '#007C27', // PerfoTec Brand Green
                blue: '#054E9A',  // PerfoTec Brand Blue (Logo)
                darkBlue: '#004B87' // Alternate Dark Blue (gebruikt in tabellen)
            },
            secondary: {
                lightBlue: '#5B9BD5', // Gebruikt voor accenten / matrix
                orange: '#ea580c'     // Voor waarschuwingen / defects
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

    // Grafiekkleuren: Strikter afgestemd op het merk
    CHART_COLORS: [
        { stroke: '#007C27', fill: '#dcfce7', name: 'PerfoTec Green' },
        { stroke: '#054E9A', fill: '#dbeafe', name: 'PerfoTec Blue' },
        { stroke: '#211A1A', fill: '#f3f4f6', name: 'PerfoTec Black' },
        { stroke: '#5B9BD5', fill: '#e0f2fe', name: 'Light Blue Accent' },
        { stroke: '#85B942', fill: '#ecfccb', name: 'Light Green Accent' }
    ],

    // === 2. DROPDOWN OPTIES ===
    PACKAGING_TYPES: [
        'Retail', 
        'Punnets', 
        'Pillow Bag', 
        'Box/ Crate', 
        'Bin crate', 
        'Cube crate', 
        'Pallet'
    ],

    TRANSPORT_MODES: [
        'Air Freight', 
        'Sea Freight', 
        'Road Transport', 
        'Storage'
    ],

    // === 3. KWALITEIT & SUPPLY CHAIN STANDAARDEN ===
    DEFAULT_CRITERIA: [
        'General Quality', 
        'Taste', 
        'Visual Appearance', 
        'Color',
        'Smell / Aroma', 
        'Texture / Firmness', 
        'Humidity / Condensation',
        'Dehydration / Shriveling', 
        'Moulds / Decay', 
        'Internal Browning'
    ],

    DEFAULT_SUPPLY_CHAIN: [
        { stage: 'Farm / Harvest', tempStart: '15', tempEnd: '', daysStart: '0.5', daysEnd: '', action: 'none' },
        { stage: 'Packing House', tempStart: '12', tempEnd: '', daysStart: '1', daysEnd: '', action: 'pack' },
        { stage: 'Transport by road', tempStart: '6', tempEnd: '', daysStart: '2', daysEnd: '', action: 'none' },
        { stage: 'Importer / Processor', tempStart: '8', tempEnd: '', daysStart: '1', daysEnd: '', action: 'none' },
        { stage: 'Retail Store', tempStart: '18', tempEnd: '', daysStart: '4', daysEnd: '', action: 'none' },
        { stage: 'Consumer (Open Pack)', tempStart: '20', tempEnd: '', daysStart: '2', daysEnd: '', action: 'unpack' }
    ],

    // === 4. BEOORDELINGSSCHALEN (Voor Report) ===
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
    // Voeg hier simpelweg talen toe om de dropdown overal in de app uit te breiden.
    LANGUAGES: [
        { code: 'en', label: 'EN' },
        { code: 'nl', label: 'NL' },
        { code: 'es', label: 'ES' }
    ],

    // Slimme functie die de juiste taal kiest (LocalStorage -> Systeemtaal -> Fallback)
    getLanguage: function() {
        // 1. Check of de gebruiker eerder een taal heeft gekozen
        const savedLang = localStorage.getItem('perfotec_lang');
        if (savedLang && this.LANGUAGES.find(l => l.code === savedLang)) {
            return savedLang;
        }

        // 2. Check de taal van het besturingssysteem/browser
        if (typeof navigator !== 'undefined') {
            const browserLang = (navigator.language || navigator.userLanguage || '').substring(0, 2).toLowerCase();
            if (this.LANGUAGES.find(l => l.code === browserLang)) {
                return browserLang;
            }
        }

        // 3. Standaard terugvallen op Engels
        return 'en';
    },

    // Functie om de taal centraal op te slaan
    setLanguage: function(code) {
        if (this.LANGUAGES.find(l => l.code === code)) {
            localStorage.setItem('perfotec_lang', code);
            return true;
        }
        return false;
    }
};

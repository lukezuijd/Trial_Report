// config.js
window.PERFOTEC_CONFIG = {
    brand: {
        colors: { 
            green: '#007C27', 
            blue: '#054E9A', 
            black: '#211A1A',
            gray: '#E9E9E9', 
            lightGray: '#F3F4F6', 
            white: '#FFFFFF' 
        },
        fonts: { 
            heading: '"League Spartan", sans-serif', 
            body: '"Inter", sans-serif' 
        }
    },
    packagingTypes: ['Retail', 'Box/ Crate', 'Cube crate', 'Pallet', 'Punnets', 'Pillow Bag', 'Bin crate'],
    defaultCriteria: [
        'General Quality', 'Taste', 'Visual Appearance', 'Color',
        'Smell / Aroma', 'Texture / Firmness', 'Humidity / Condensation',
        'Dehydration / Shriveling', 'Moulds / Decay', 'Internal Browning'
    ]
};

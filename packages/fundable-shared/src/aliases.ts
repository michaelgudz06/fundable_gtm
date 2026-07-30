// Ported from fundable-query-planner/config — every permalink verified live.
// Fundable's /industry/search and /location/search are literal name lookups with
// no synonyms and no relevance ranking, and a bad permalink is silently dropped
// rather than erroring. These curated maps are what keep a filter from vanishing.

export type Alias = { search: string; permalink: string };

export const LOCATION_ALIASES: Record<string, Alias> = {
  "america": {
    "permalink": "united-states",
    "search": "america"
  },
  "atl": {
    "permalink": "atlanta-georgia",
    "search": "Atlanta"
  },
  "atlanta": {
    "permalink": "atlanta-georgia",
    "search": "Atlanta"
  },
  "atx": {
    "permalink": "austin-texas",
    "search": "Austin"
  },
  "austin": {
    "permalink": "austin-texas",
    "search": "Austin"
  },
  "bay area": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "beantown": {
    "permalink": "boston-massachusetts",
    "search": "Boston"
  },
  "bellevue": {
    "permalink": "bellevue-washington",
    "search": "Bellevue"
  },
  "berkeley": {
    "permalink": "berkeley-california",
    "search": "Berkeley"
  },
  "berlin": {
    "permalink": "berlin-berlin",
    "search": "berlin"
  },
  "big apple": {
    "permalink": "new-york-new-york",
    "search": "New York"
  },
  "boston": {
    "permalink": "boston-massachusetts",
    "search": "Boston"
  },
  "cambridge": {
    "permalink": "cambridge-massachusetts",
    "search": "Cambridge"
  },
  "chi": {
    "permalink": "chicago-illinois",
    "search": "Chicago"
  },
  "chi town": {
    "permalink": "chicago-illinois",
    "search": "Chicago"
  },
  "chi-town": {
    "permalink": "chicago-illinois",
    "search": "Chicago"
  },
  "chicago": {
    "permalink": "chicago-illinois",
    "search": "Chicago"
  },
  "d.c.": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "dallas": {
    "permalink": "dallas-texas",
    "search": "Dallas"
  },
  "dc": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "denver": {
    "permalink": "denver-colorado-b063",
    "search": "Denver"
  },
  "detroit": {
    "permalink": "detroit-michigan",
    "search": "Detroit"
  },
  "dfw": {
    "permalink": "dallas-texas",
    "search": "Dallas"
  },
  "dmv": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "emerald city": {
    "permalink": "seattle-washington",
    "search": "Seattle"
  },
  "emeryville": {
    "permalink": "emeryville-california",
    "search": "Emeryville"
  },
  "frisco": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "greater boston": {
    "permalink": "boston-massachusetts",
    "search": "Boston"
  },
  "greater miami": {
    "permalink": "miami-florida",
    "search": "Miami"
  },
  "greater seattle": {
    "permalink": "seattle-washington",
    "search": "Seattle"
  },
  "h town": {
    "permalink": "houston-texas",
    "search": "Houston"
  },
  "h-town": {
    "permalink": "houston-texas",
    "search": "Houston"
  },
  "hollywood": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "houston": {
    "permalink": "houston-texas",
    "search": "Houston"
  },
  "htown": {
    "permalink": "houston-texas",
    "search": "Houston"
  },
  "kendall square": {
    "permalink": "cambridge-massachusetts",
    "search": "Cambridge"
  },
  "l.a.": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "la": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "las vegas": {
    "permalink": "las-vegas-nevada",
    "search": "Las Vegas"
  },
  "london": {
    "permalink": "london-england",
    "search": "london"
  },
  "los angeles": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "manhattan": {
    "permalink": "new-york-new-york",
    "search": "New York"
  },
  "menlo park": {
    "permalink": "menlo-park-california",
    "search": "Menlo Park"
  },
  "metroplex": {
    "permalink": "dallas-texas",
    "search": "Dallas"
  },
  "miami": {
    "permalink": "miami-florida",
    "search": "Miami"
  },
  "mile high city": {
    "permalink": "denver-colorado-b063",
    "search": "Denver"
  },
  "minneapolis": {
    "permalink": "minneapolis-minnesota",
    "search": "Minneapolis"
  },
  "motor city": {
    "permalink": "detroit-michigan",
    "search": "Detroit"
  },
  "mountain view": {
    "permalink": "mountain-view-california",
    "search": "Mountain View"
  },
  "msp": {
    "permalink": "minneapolis-minnesota",
    "search": "Minneapolis"
  },
  "music city": {
    "permalink": "nashville-tennessee-4e91",
    "search": "Nashville"
  },
  "nashville": {
    "permalink": "nashville-tennessee-4e91",
    "search": "Nashville"
  },
  "new orleans": {
    "permalink": "new-orleans-louisiana",
    "search": "New Orleans"
  },
  "new york": {
    "permalink": "new-york-new-york",
    "search": "New York"
  },
  "nola": {
    "permalink": "new-orleans-louisiana",
    "search": "New Orleans"
  },
  "ny": {
    "permalink": "new-york-new-york",
    "search": "New York"
  },
  "nyc": {
    "permalink": "new-york-new-york",
    "search": "New York"
  },
  "oakland": {
    "permalink": "oakland-california",
    "search": "Oakland"
  },
  "palo alto": {
    "permalink": "palo-alto-california",
    "search": "Palo Alto"
  },
  "paris": {
    "permalink": "paris-ile-de-france",
    "search": "paris"
  },
  "pdx": {
    "permalink": "portland-oregon",
    "search": "Portland"
  },
  "philadelphia": {
    "permalink": "philadelphia-pennsylvania",
    "search": "Philadelphia"
  },
  "philly": {
    "permalink": "philadelphia-pennsylvania",
    "search": "Philadelphia"
  },
  "phoenix": {
    "permalink": "phoenix-arizona",
    "search": "Phoenix"
  },
  "portland": {
    "permalink": "portland-oregon",
    "search": "Portland"
  },
  "redmond": {
    "permalink": "redmond-washington",
    "search": "Redmond"
  },
  "redwood city": {
    "permalink": "redwood-city-california",
    "search": "Redwood City"
  },
  "s.f.": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "salt lake": {
    "permalink": "salt-lake-city-utah",
    "search": "Salt Lake City"
  },
  "salt lake city": {
    "permalink": "salt-lake-city-utah",
    "search": "Salt Lake City"
  },
  "san diego": {
    "permalink": "san-diego-california",
    "search": "San Diego"
  },
  "san fran": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "san francisco": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "san francisco bay area": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "san jose": {
    "permalink": "san-jose-california",
    "search": "San Jose"
  },
  "san mateo": {
    "permalink": "san-mateo-california",
    "search": "San Mateo"
  },
  "sd": {
    "permalink": "san-diego-california",
    "search": "San Diego"
  },
  "seattle": {
    "permalink": "seattle-washington",
    "search": "Seattle"
  },
  "sf": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "sf bay area": {
    "permalink": "san-francisco-california",
    "search": "San Francisco"
  },
  "silicon beach": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "sin city": {
    "permalink": "las-vegas-nevada",
    "search": "Las Vegas"
  },
  "singapore": {
    "permalink": "singapore-singapore",
    "search": "singapore"
  },
  "slc": {
    "permalink": "salt-lake-city-utah",
    "search": "Salt Lake City"
  },
  "socal": {
    "permalink": "los-angeles-california",
    "search": "Los Angeles"
  },
  "soflo": {
    "permalink": "miami-florida",
    "search": "Miami"
  },
  "south florida": {
    "permalink": "miami-florida",
    "search": "Miami"
  },
  "south san francisco": {
    "permalink": "south-san-francisco-california",
    "search": "South San Francisco"
  },
  "tel aviv": {
    "permalink": "tel-aviv-tel-aviv",
    "search": "tel aviv"
  },
  "the states": {
    "permalink": "united-states",
    "search": "the states"
  },
  "toronto": {
    "permalink": "toronto-ontario",
    "search": "toronto"
  },
  "twin cities": {
    "permalink": "minneapolis-minnesota",
    "search": "Minneapolis"
  },
  "united states": {
    "permalink": "united-states",
    "search": "united states"
  },
  "us": {
    "permalink": "united-states",
    "search": "us"
  },
  "usa": {
    "permalink": "united-states",
    "search": "usa"
  },
  "valley of the sun": {
    "permalink": "phoenix-arizona",
    "search": "Phoenix"
  },
  "vegas": {
    "permalink": "las-vegas-nevada",
    "search": "Las Vegas"
  },
  "washington": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "washington d.c.": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "washington dc": {
    "permalink": "washington-district-of-columbia",
    "search": "Washington"
  },
  "windy city": {
    "permalink": "chicago-illinois",
    "search": "Chicago"
  }
};

export const INDUSTRY_ALIASES: Record<string, Alias> = {
  "ai": {
    "permalink": "artificial-intelligence",
    "search": "artificial intelligence"
  },
  "artificial intelligence": {
    "permalink": "artificial-intelligence",
    "search": "artificial intelligence"
  },
  "cleantech": {
    "permalink": "clean-energy",
    "search": "clean energy"
  },
  "climate": {
    "permalink": "clean-energy",
    "search": "clean energy"
  },
  "climate tech": {
    "permalink": "clean-energy",
    "search": "clean energy"
  },
  "climatetech": {
    "permalink": "clean-energy",
    "search": "clean energy"
  },
  "crypto": {
    "permalink": "cryptocurrency",
    "search": "cryptocurrency"
  },
  "cryptocurrency": {
    "permalink": "cryptocurrency",
    "search": "cryptocurrency"
  },
  "cyber security": {
    "permalink": "cyber-security",
    "search": "cyber security"
  },
  "cybersecurity": {
    "permalink": "cyber-security",
    "search": "cyber security"
  },
  "digital health": {
    "permalink": "health-care",
    "search": "health care"
  },
  "e commerce": {
    "permalink": "e-commerce-275d",
    "search": "e-commerce"
  },
  "ecommerce": {
    "permalink": "e-commerce-275d",
    "search": "e-commerce"
  },
  "fintech": {
    "permalink": "fintech-e067",
    "search": "fintech"
  },
  "health care": {
    "permalink": "health-care",
    "search": "health care"
  },
  "health tech": {
    "permalink": "health-care",
    "search": "health care"
  },
  "healthcare": {
    "permalink": "health-care",
    "search": "health care"
  },
  "healthtech": {
    "permalink": "health-care",
    "search": "health care"
  },
  "machine learning": {
    "permalink": "machine-learning",
    "search": "machine learning"
  },
  "medical technology": {
    "permalink": "medical-device",
    "search": "medical device"
  },
  "medtech": {
    "permalink": "medical-device",
    "search": "medical device"
  },
  "ml": {
    "permalink": "machine-learning",
    "search": "machine learning"
  },
  "saas": {
    "permalink": "saas-5c4e",
    "search": "saas"
  }
};

export const ROUND_PHRASES: Record<string, { type: string; pre?: boolean; extension?: boolean }> = {
  "pre-seed": {
    "type": "SEED",
    "pre": true
  },
  "preseed": {
    "type": "SEED",
    "pre": true
  },
  "pre seed": {
    "type": "SEED",
    "pre": true
  },
  "seed": {
    "type": "SEED"
  },
  "seed extension": {
    "type": "SEED",
    "extension": true
  },
  "series a": {
    "type": "SERIES_A"
  },
  "series a extension": {
    "type": "SERIES_A",
    "extension": true
  },
  "series b": {
    "type": "SERIES_B"
  },
  "series b extension": {
    "type": "SERIES_B",
    "extension": true
  },
  "series c": {
    "type": "SERIES_C"
  },
  "series d": {
    "type": "SERIES_D"
  },
  "series e": {
    "type": "SERIES_E"
  },
  "series f": {
    "type": "SERIES_F"
  },
  "safe": {
    "type": "SAFE"
  },
  "convertible note": {
    "type": "CONVERTIBLE_NOTE"
  },
  "convertible": {
    "type": "CONVERTIBLE_NOTE"
  },
  "grant": {
    "type": "GRANT"
  },
  "debt": {
    "type": "DEBT_FINANCING"
  },
  "debt financing": {
    "type": "DEBT_FINANCING"
  },
  "venture debt": {
    "type": "DEBT_FINANCING"
  },
  "crowdfunding": {
    "type": "CROWDFUNDING"
  },
  "ico": {
    "type": "INITIAL_COIN_OFFERING"
  },
  "token sale": {
    "type": "INITIAL_COIN_OFFERING"
  },
  "secondary": {
    "type": "SECONDARY_MARKET"
  },
  "equity": {
    "type": "EQUITY"
  },
  "preferred": {
    "type": "PREFERRED"
  }
};

export const ROUND_EXPANSIONS: Record<string, { type: string; pre?: boolean; extension?: boolean }[]> = {
  "early stage": [
    {
      "type": "SEED",
      "pre": true
    },
    {
      "type": "SEED"
    },
    {
      "type": "SERIES_A"
    }
  ],
  "late stage": [
    {
      "type": "SERIES_C"
    },
    {
      "type": "SERIES_D"
    },
    {
      "type": "SERIES_E"
    }
  ],
  "growth": [
    {
      "type": "SERIES_C"
    },
    {
      "type": "SERIES_D"
    },
    {
      "type": "SERIES_E"
    },
    {
      "type": "SERIES_F"
    }
  ]
};

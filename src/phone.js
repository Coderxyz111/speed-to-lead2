// Normalise phone numbers typed into Facebook lead forms into WhatsApp IDs
// (international format, digits only, e.g. "6591234567").

const COUNTRY_RULES = {
  // Singapore: 8 digits, no trunk prefix. Mobiles start with 8 or 9 (6xxx = landline, no WhatsApp).
  SG: { code: '65', trunk: null, nationalLength: 8, mobilePrefixes: ['8', '9'] },
  // Australia: mobiles are 04xx xxx xxx locally, +61 4xx xxx xxx internationally.
  AU: { code: '61', trunk: '0', nationalLength: 9, mobilePrefixes: ['4'] },
};

function normalisePhone(raw, defaultCountry = 'SG') {
  if (!raw) return null;
  const rule = COUNTRY_RULES[defaultCountry];
  if (!rule) throw new Error(`Unsupported default country: ${defaultCountry}`);

  const s = String(raw).trim();
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // "0065 9123 4567" international dialing prefix
  if (digits.startsWith('00')) return checkHome(validLength(digits.slice(2)), rule);
  if (hadPlus) return checkHome(fixTrunkAfterCode(digits, rule), rule);

  // Already has the country code, e.g. "6591234567"
  if (digits.startsWith(rule.code) && digits.length >= rule.code.length + rule.nationalLength) {
    return checkHome(fixTrunkAfterCode(digits, rule), rule);
  }

  // Local format, e.g. "9123 4567"
  if (rule.trunk && digits.startsWith(rule.trunk)) digits = digits.slice(rule.trunk.length);
  if (digits.length !== rule.nationalLength) return null;
  return checkHome(rule.code + digits, rule);
}

// Handles people typing "+61 0412 345 678"
function fixTrunkAfterCode(digits, rule) {
  if (rule.trunk && digits.startsWith(rule.code + rule.trunk)) {
    digits = rule.code + digits.slice(rule.code.length + rule.trunk.length);
  }
  return validLength(digits);
}

// For home-country numbers, reject landlines (they can't have WhatsApp).
// Foreign numbers (another country code) are passed through as-is.
function checkHome(digits, rule) {
  if (!digits || !digits.startsWith(rule.code)) return digits;
  const national = digits.slice(rule.code.length);
  if (national.length !== rule.nationalLength) return null;
  if (rule.mobilePrefixes && !rule.mobilePrefixes.some(p => national.startsWith(p))) return null;
  return digits;
}

function validLength(digits) {
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

module.exports = { normalisePhone };

// Company-wide cedula key. Exact port of backend-trazabilidad `normalizarCedula`
// (services/empleadosSiesaService.js): digits only, leading zeros stripped, and an
// all-zero value keeps its digits ("0000" stays "0000"). Every module must use this helper.
export function normalizeCedula(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const withoutZeros = digits.replace(/^0+/, "");
  return withoutZeros || digits;
}

/** True when the normalized cedula has 5 to 15 digits. */
export function isValidCedula(value) {
  return /^[0-9]{5,15}$/.test(normalizeCedula(value));
}

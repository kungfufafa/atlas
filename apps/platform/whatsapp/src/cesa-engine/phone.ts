export function formatCesaWhatsAppPhone(phone: string): string {
  let digits = String(phone || "").replace(/\D/g, "");

  if (digits.startsWith("0")) {
    digits = `62${digits.slice(1)}`;
  } else if (digits.startsWith("8")) {
    digits = `62${digits}`;
  }

  return digits;
}

export function isCesaWhatsAppPhone(phone: unknown): phone is string {
  if (typeof phone !== "string" || !/^[+\d\s().-]+$/.test(phone)) {
    return false;
  }
  return /^[1-9][0-9]{7,14}$/.test(formatCesaWhatsAppPhone(phone));
}

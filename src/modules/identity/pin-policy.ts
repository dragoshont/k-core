export const WEAK_PINS = new Set([
	"0000",
	"1111",
	"1212",
	"1234",
	"2222",
	"3333",
	"4444",
	"5555",
	"6666",
	"7777",
	"8888",
	"9999",
]);

export function validatePinFormat(pin: string) {
	return /^[0-9]{4}$/.test(pin);
}

export function assertAllowedPin(pin: string, currentPin?: string | null) {
	if (!validatePinFormat(pin)) {
		return { code: "pin_invalid", ok: false as const, reason: "PIN must be exactly four digits." };
	}

	if (WEAK_PINS.has(pin)) {
		return { code: "pin_weak", ok: false as const, reason: "Choose a PIN that is not common or sequential." };
	}

	if (currentPin && currentPin === pin) {
		return { code: "pin_unchanged", ok: false as const, reason: "Choose a PIN that is different from the current PIN." };
	}

	return { ok: true as const };
}
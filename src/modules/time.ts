export function addMinutes(date: Date, minutes: number) {
	return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addHours(date: Date, hours: number) {
	return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
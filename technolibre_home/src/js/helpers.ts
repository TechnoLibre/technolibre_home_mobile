export const helpers = {
  formatDate(date: string | number) {
    return (new Date(date)).toLocaleDateString("fr-CA", {
				day: "numeric",
				month: "long",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false
			}
		);
  }
}
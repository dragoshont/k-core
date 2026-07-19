import { inspect } from "node:util";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export class ApplicationSecrets {
	readonly #googleBooksApiKey: string | undefined;

	private constructor(googleBooksApiKey?: string) {
		this.#googleBooksApiKey = googleBooksApiKey;
	}

	static fromEnvironment(env: NodeJS.ProcessEnv) {
		if (env.GOOGLE_BOOKS_API_KEY === undefined) return new ApplicationSecrets();
		return ApplicationSecrets.fromGoogleBooksApiKey(env.GOOGLE_BOOKS_API_KEY);
	}

	static fromGoogleBooksApiKey(value: string) {
		if (value.length < 16 || value.length > 1024 || CONTROL_CHARACTER.test(value)) {
			throw new Error("GOOGLE_BOOKS_API_KEY is invalid");
		}
		return new ApplicationSecrets(value);
	}

	hasGoogleBooksApiKey() {
		return this.#googleBooksApiKey !== undefined;
	}

	withGoogleBooksApiKey<T>(callback: (value: string) => T): T | undefined {
		return this.#googleBooksApiKey === undefined ? undefined : callback(this.#googleBooksApiKey);
	}

	toJSON() {
		return undefined;
	}

	[inspect.custom]() {
		return "ApplicationSecrets { [redacted] }";
	}
}
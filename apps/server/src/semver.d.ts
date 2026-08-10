declare module "semver" {
	interface SemverOptions {
		includePrerelease?: boolean;
		loose?: boolean;
	}

	interface SemverApi {
		validRange(range: string, options?: SemverOptions): string | null;
		satisfies(version: string, range: string, options?: SemverOptions): boolean;
	}

	const semver: SemverApi;
	export default semver;
}

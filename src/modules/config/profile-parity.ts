import type { QueryResultRow } from "pg";
import type { SqlExecutor } from "../db/database";
import { ProblemError } from "../http/problems";
import type { ProfileConfig } from "./profile-config";

export const PROFILE_CONFIGURATION_MISMATCH = "profile_configuration_mismatch";

interface ProfileAliasRow extends QueryResultRow {
	display_name: string;
	profile_id: string;
	slug: string;
}

export async function profileConfigurationMatches(executor: SqlExecutor, config: ProfileConfig) {
	const result = await executor.query<ProfileAliasRow>(`
		select profile_id, slug, display_name
		from profiles
		order by profile_id
	`);
	return result.rows.length === config.profiles.length
		&& config.profiles.every((profile, index) => {
			const row = result.rows[index];
			return row?.profile_id === profile.profileId
				&& row.slug === profile.slug
				&& row.display_name === profile.displayName;
		});
}

export async function assertProfileConfigurationParity(executor: SqlExecutor, config: ProfileConfig) {
	if (!(await profileConfigurationMatches(executor, config))) {
		throw new ProblemError(503, PROFILE_CONFIGURATION_MISMATCH, "Service is not ready");
	}
}
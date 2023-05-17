import { IDatabase } from "pg-promise";

export const runSchema = async(db: IDatabase<unknown>) => {
    await db.none(`
        create table wporg_users
        (
            id text not null
                constraint wporg_users_pk
                    primary key,
            slack_user_id text not null
                constraint wporg_users_slack_user_id
                    unique
        );
    `);
};

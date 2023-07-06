import { IDatabase } from "pg-promise";

export const runSchema = async(db: IDatabase<unknown>) => {
    await db.none(`
        alter table wporg_users
            rename to matrix_usernames;
        alter table matrix_usernames
            rename column wporg_id to matrix_username;
        alter table matrix_usernames
            rename constraint wporg_users_pk to matrix_usernames_pk;
        alter table matrix_usernames
            rename constraint wporg_users_slack_id to matrix_usernames_slack_id;
    `);
};

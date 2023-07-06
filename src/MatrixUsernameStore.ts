import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";

type MatrixUsername = string;

export class MatrixUsernameStore {
    private readonly teamDomains: string[];

    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
        if (!config.matrix_username_store) {
            throw Error("matrix_username_store is not correctly configured");
        }

        this.teamDomains = config.matrix_username_store.team_domains;
    }

    hasMappingForTeam(teamDomain: string): boolean {
        return this.teamDomains.includes(teamDomain);
    }

    async getBySlackUserId(slackUserId: string): Promise<MatrixUsername | null> {
        return await this.datastore.getMatrixUsername(slackUserId);
    }
}

import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";

type MatrixUsername = string;

export class MatrixUsernameStore {
    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
    }

    hasMappingForTeam(teamDomain: string): boolean {
        return ["wordpress", "orbit-sandbox"].includes(teamDomain);
    }

    async getBySlackUserId(slackUserId: string): Promise<MatrixUsername | null> {
        return await this.datastore.getMatrixUsername(slackUserId);
    }
}

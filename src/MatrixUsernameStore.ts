import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";

type MatrixUsername = string;

export class MatrixUsernameStore {
    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
    }

    async getBySlackUserId(slackUserId: string): Promise<MatrixUsername | null> {
        const username = await this.datastore.getMatrixUsername(slackUserId);
        if (!username) {
            return null;
        }

        return `@${username}:${this.config.homeserver.server_name}`;
    }
}

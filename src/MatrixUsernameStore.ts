import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";
import axios, {AxiosInstance} from "axios";
import {Logger} from "matrix-appservice-bridge";

type MatrixUsername = string;

const log = new Logger("MatrixUsernameStore");

export class MatrixUsernameStore {
    private readonly teamDomains: string[];
    private readonly url: URL;

    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
        if (!config.matrix_username_store) {
            throw Error("matrix_username_store is not correctly configured");
        }

        if (config.matrix_username_store?.url.startsWith("http://")) {
            throw new Error(`matrix_username_store.url must be an https URL, got ${config.matrix_username_store.url}`);
        }

        if (!config.matrix_username_store?.secret) {
            throw new Error(`matrix_username_store.secret must be set`);
        }

        this.teamDomains = config.matrix_username_store.team_domains;
        this.url = new URL(`${config.matrix_username_store.url}?secret=${config.matrix_username_store.secret}`);
    }

    hasMappingForTeam(teamDomain: string): boolean {
        return this.teamDomains.includes(teamDomain);
    }

    async getBySlackUserId(slackUserId: string): Promise<MatrixUsername | null> {
        const username = await this.datastore.getMatrixUsername(slackUserId);
        if (username) {
            return username;
        }

        log.debug(`Retrieving matrix username for ${slackUserId} from remote store`);
        const remoteUsername = await this.getFromRemote(slackUserId);
        if (!remoteUsername) {
            return null;
        }

        await this.datastore.setMatrixUsername(slackUserId, remoteUsername);
        return remoteUsername;
    }

    private async getFromRemote(slackUserId: string): Promise<MatrixUsername | null> {
        const client = axios.create();
        const {status, data} = await client.get(`${this.url.toString()}&slack_id=${slackUserId}`);

        if (status !== 200 || data.error || !data.matrix) {
            log.warn("Failed to retrieve matrix username", status, data);
            return null;
        }

        return data.matrix;
    }
}

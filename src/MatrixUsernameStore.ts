import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";
import axios, {AxiosError, AxiosResponse} from "axios";
import {Logger} from "matrix-appservice-bridge";

type MatrixUsername = string;

const log = new Logger("MatrixUsernameStore");

export class MatrixUsernameStore {
    private readonly teamDomain: string;
    private readonly url: URL;
    private readonly cache = new Map<string, string>();

    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
        if (!config.matrix_username_store) {
            throw Error("matrix_username_store is not correctly configured");
        }

        if (!config.matrix_username_store.url) {
            throw new Error(`matrix_username_store.url must be set`);
        }

        if (!config.matrix_username_store?.secret) {
            throw new Error(`matrix_username_store.secret must be set`);
        }

        this.teamDomain = config.matrix_username_store.team_domain;
        this.url = new URL(`${config.matrix_username_store.url}?secret=${config.matrix_username_store.secret}`);
    }

    hasMappingForTeam(teamDomain: string): boolean {
        return this.teamDomain === teamDomain;
    }

    async getBySlackUserId(slackUserId: string): Promise<MatrixUsername | null> {
        let username = this.cache.get(slackUserId) ?? null;
        if (username) {
            log.debug(`Retrieved matrix username from cache: ${username}`);
            return username;
        }

        username = await this.datastore.getMatrixUsername(slackUserId);
        if (username) {
            log.debug(`Retrieved matrix username from database: ${username}`);
            this.cache.set(slackUserId, username);
            return username;
        }

        username = await this.getFromRemote(slackUserId);
        if (!username) {
            return null;
        }

        log.debug(`Retrieved matrix username from remote store: ${username}`);
        await this.datastore.setMatrixUsername(slackUserId, username);
        this.cache.set(slackUserId, username);
        return username;
    }

    private async getFromRemote(slackUserId: string): Promise<MatrixUsername | null> {
        const client = axios.create();

        const logError = (r: AxiosResponse | undefined) => {
            log.debug(`Failed to retrieve Matrix username for ${slackUserId}:`, r?.status, r?.statusText, r?.headers, r?.data);
        };

        let response: AxiosResponse;
        try {
            response = await client.get(`${this.url.toString()}&slack_id=${slackUserId}`);
            if (response.data.error || !response.data.matrix) {
                logError(response);
                return null;
            }
            return response.data.matrix;
        } catch (error) {
            logError((error as AxiosError).response);
            return null;
        }
    }
}

import {Datastore} from "./datastore/Models";
import {IConfig} from "./IConfig";

export class MatrixUsernameStore {
    constructor(
        private datastore: Datastore,
        private config: IConfig,
    ) {
    }
}

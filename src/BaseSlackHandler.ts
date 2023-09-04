/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Main } from "./Main";

export const INTERNAL_ID_LEN = 32;
export const HTTP_CODES = {
    CLIENT_ERROR: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    OK: 200,
    SERVER_ERROR: 500,
};

export interface ISlackEvent {
    type: string;
    channel: string;
    ts: string;
    bot_id?: string;
    team_domain?: string;
    user_id: string;
}

export interface ISlackEventMessageAttachment {
    fallback: string;
    pretext?: string;
    text?: string;
    title?: string;
    title_link?: string;
    author_name?: string;
}

export interface ISlackMessageEvent extends ISlackEvent {
    team_domain?: string;
    team_id?: string;
    user?: string;
    user_id: string;
    inviter?: string;
    item?: {
        type: string;
        channel: string;
        ts: string;
    };
    subtype?: string;
    bot_id?: string;
    text?: string;
    deleted_ts?: string;
    // For comments
    comment?: {
        user: string;
    };
    attachments?: ISlackEventMessageAttachment[];
    // For message_changed
    message?: ISlackMessageEvent;
    previous_message?: ISlackMessageEvent;
    file?: ISlackFile;
    files?: ISlackFile[];
    /**
     * PSA: `event_ts` refers to the time an event was acted upon,
     * and `ts` is the events timestamp itself. Use `event_ts` over `ts`
     * when handling.
     */
    event_ts?: string;
    thread_ts?: string;
}

export interface ISlackMessageDeletedEvent extends Omit<ISlackMessageEvent, "deleted_ts"> {
    deleted_ts: string;
}

export interface ISlackFile {
    name?: string;
    thumb_360?: string;
    thumb_video?: string;
    filetype?: string;
    mode?: string;
    title: string;
    mimetype: string;
    permalink_public?: string;
    id: string;
    url_private?: string;
    public_url_shared?: string;
    permalink?: string;
    size: number;
    shares?: {
        public?: {
            [channelId: string]: {
                ts: string;
            }
        },
        private?: {
            [channelId: string]: {
                ts: string;
            }[]
        }
    }
}

export interface ISlackUser {
    id: string;
    deleted: boolean;
    name: string;
    profile?: {
        display_name?: string;
        real_name?: string;
        image_original?: string;
        image_1024?: string;
        image_512?: string;
        image_192?: string;
        image_72?: string;
        image_48?: string;
        bot_id?: string;
        avatar_hash?: string;
    };
}

export abstract class BaseSlackHandler {
    protected constructor(protected main: Main) {}
}

import {
    ISlackEventMessageAttachment,
    ISlackMessageEvent,
    ISlackFile,
    ISlackEventMessageBlock
} from "./BaseSlackHandler";
import * as Slackdown from "slackdown";
import {
    TextualMessageEventContent,
    MessageEventContent,
    AudioMessageEventContent,
    VideoMessageEventContent,
    ImageMessageEventContent,
    FileMessageEventContent,
} from "matrix-bot-sdk";
import substitutions, {getFallbackForMissingEmoji} from "./substitutions";
import {WebClient} from "@slack/web-api";
import {SlackRoomStore} from "./SlackRoomStore";
import {AppServiceBot, Intent, Logger} from "matrix-appservice-bridge";
import {ConversationsInfoResponse} from "./SlackResponses";
import {Datastore, EventEntry} from "./datastore/Models";
import {SlackGhostStore} from "./SlackGhostStore";
import {Main} from "./Main";
import * as emoji from "node-emoji";
import MarkdownIt from "markdown-it";
import {SlackClientFactory} from "./SlackClientFactory";
import {SlackChannelType} from "./BridgedRoom";
import axios from "axios";

const CHANNEL_ID_REGEX = /<#(\w+)\|?\w*?>/g;

// If the message is an emote, the format is <@ID|nick>, but in normal messages it's just <@ID>.
const USER_ID_REGEX = /<@(\w+)\|?\w*?>/g;

const log = new Logger("SlackMessageParser");

/**
 * Parses the content of a Slack message into zero, one, or more `m.message` Matrix events.
 */
export class SlackMessageParser {
    private readonly handledSubtypes = [
        undefined, // Messages with no subtype
        "me_message",
        "bot_message",
        "message_changed",
    ];

    private readonly markdown: MarkdownIt;

    constructor(
        private readonly matrixBotIntent: Intent,
        private readonly datastore: Datastore,
        private readonly roomStore: SlackRoomStore,
        private readonly ghostStore: SlackGhostStore,
        private readonly bridgeMatrixBot: AppServiceBot,
        private readonly matrixRoomId: string,
        private readonly botSlackClient: WebClient,
        private readonly slackTeamId: string,
        private readonly slackChannelType: SlackChannelType,
        private readonly isPrivateChannel: boolean,
        private readonly slackClientFactory: SlackClientFactory,
        private readonly maxUploadSize: number | undefined,
        // Main is only for getTeamDomainForMessage()
        // TODO: Refactor getTeamDomainForMessage() into something that can be injected.
        //       Also, there are currently two implementations of getTeamDomainForMessage() in the codebase.
        //       There should be a single one.
        private readonly main: Main,
    ) {
        this.markdown = new MarkdownIt({
            // Allow HTML to pass through as is.
            html: true,
            // Convert \n to <br> in paragraphs.
            breaks: true,
        });
    }

    async parse(message: ISlackMessageEvent): Promise<MessageEventContent[]> {
        const subtype = message.subtype;
        if (!this.handledSubtypes.includes(subtype)) {
            return [];
        }

        if (subtype === "me_message") {
            return [this.makeTextualEventContent("m.emote", message.text || "")];
        }

        const parsedFiles: MessageEventContent[] = [];
        for (const file of message.files || []) {
            const parsedFile = await this.parseFile(file);
            if (parsedFile) {
                parsedFiles.push(parsedFile);
            }
        }

        let text = "";

        for (const block of message.blocks || []) {
            text += this.parseBlock(block);
        }

        for (const attachment of message.attachments || []) {
            text += this.parseAttachment(attachment);
        }

        if (text.trim() === "") {
            text = message.text || "";
        }

        if (text === "") {
            return [...parsedFiles];
        }

        const teamDomain = await this.main.getTeamDomainForMessage(message);
        const parsedMessage = await this.doParse(text, message.channel, teamDomain);
        const matrixEvents: MessageEventContent[] = [];

        if (subtype === "message_changed" && message.previous_message?.text) {
            // It's an edit.
            let previousEvent: EventEntry | null = null;
            if (message.previous_message?.ts) {
                previousEvent = await this.datastore.getEventBySlackId(message.channel, message.previous_message.ts);
            }

            if (!previousEvent) {
                // If the event we're editing was not found, we consider this to be a new message.
                matrixEvents.push(parsedMessage);
                log.warn(`Previous event not found when editing message. message.ts: ${message.ts}`);
            } else {
                const parsedPreviousMessage = await this.doParse(message.previous_message.text, message.channel, teamDomain);
                matrixEvents.push(this.parseEdit(parsedMessage, parsedPreviousMessage, previousEvent));
            }
        } else {
            // Not an edit.
            matrixEvents.push(parsedMessage, ...parsedFiles);
        }

        return this.injectExternalUrl(message, matrixEvents);
    }

    private async parseFile(file: ISlackFile): Promise<MessageEventContent | null> {
        if (!file.url_private) {
            log.warn(`Slack file ${file.id} lacks a url_private, not handling file.`);
            return null;
        }

        const slackClient = await this.getSlackClientForFileHandling();

        let parseAsLink = false;
        if (!slackClient || !slackClient.token) {
            log.warn("We have no client (or token) that can handle this file, parsing as link.");
            parseAsLink = true;
        } else if (this.maxUploadSize && file.size > this.maxUploadSize) {
            log.warn(`File size too large (${file.size / 1024}KiB > ${this.maxUploadSize / 1024} KB).`);
            parseAsLink = true;
        }

        if (parseAsLink) {
            const url = file.public_url_shared ? file.permalink_public : file.url_private;
            return this.makeTextualEventContent(
                "m.text",
                `${url} (${file.name})`,
                `<a href="${url}">${file.name}</a>`,
            );
        }

        if (file.mode === "snippet" && slackClient) {
            return this.parseSnippet(file, slackClient);
        }

        return null;
    }

    private async parseSnippet(file: ISlackFile, slackClient: WebClient): Promise<TextualMessageEventContent | null> {
        if (!file.url_private) {
            return null;
        }

        let content = "";
        try {
            const response = await axios.get<string>(file.url_private, {
                headers: {
                    Authorization: `Bearer ${slackClient.token}`,
                }
            });
            if (response.status !== 200) {
                throw Error(`${response.status}`);
            }
            content = response.data;
        } catch (error) {
            log.error("Failed to download snippet", error);
        }

        if (!content || content.trim() === "") {
            return null;
        }

        const body = "```" + `\n${content}\n` + "```";
        let formattedBody = "<pre><code>";
        if (file.filetype) {
            formattedBody = `<pre><code class="language-${file.filetype}'">`;
        }
        formattedBody += substitutions.htmlEscape(content);
        formattedBody += "</code></pre>";

        return this.makeTextualEventContent("m.text", body, formattedBody);
    }

    private parseAttachment(attachment: ISlackEventMessageAttachment): string {
        const {blocks, pretext, text, fallback, title, title_link, author_name} = attachment;
        let content = "";

        if (blocks) {
            for (const block of blocks) {
                content += this.parseBlock(block);
            }
        } else if (!text) {
            content += fallback;
        } else {
            if (title) {
                if (title_link) {
                    content += `**[${title}](${title_link})**\n`;
                } else {
                    content += `**${title}**\n`;
                }
            }

            if (author_name) {
                content += `**${author_name}**\n`;
            }

            content += text;
        }

        // Quote the whole attachment.
        content = `> ${content}`;
        content = content.replaceAll("\n", "\n> ");

        if (pretext) {
            content = `${pretext}\n${content}`;
        }

        return content;
    }

    private parseBlock(block: ISlackEventMessageBlock): string {
        const {type, text, fields, elements} = block;
        let content = "";

        switch (type) {
            case "header":
                if (text) {
                    content += `# ${text.text}\n`;
                }
                break;
            case "section":
                if (text) {
                    content += `${text.text}\n`;
                    if (fields) {
                        // If there's both text and fields, separate them with an empty line.
                        content += "\n";
                    }
                }
                if (fields) {
                    for (const field of fields) {
                        content += `${field.text}\n`;
                    }
                }
                break;
            case "context":
                if (elements) {
                    for (const element of elements) {
                        if (element.text) {
                            content += `${element.text}\n`;
                        }
                    }
                }
                break;
            case "divider":
                content += `----\n`;
                break;
        }

        if (content === "") {
            return "";
        }

        return `${content}\n`;
    }

    private async doParse(
        body: string,
        channelId: string,
        teamDomain: string | undefined
    ): Promise<TextualMessageEventContent> {
        body = await this.replaceChannelIdsWithNames(body);
        if (teamDomain) {
            body = await this.replaceUserIdsWithNames(body, teamDomain, channelId);
        }

        body = body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        body = body.replace("<!channel>", "@room");
        body = body.replace("<!here>", "@room");
        body = body.replace("<!everyone>", "@room");
        body = emoji.emojify(body, getFallbackForMissingEmoji);

        // TODO: This is fixing plaintext mentions, but should be refactored.
        // https://github.com/matrix-org/matrix-appservice-slack/issues/110
        body = body.replace(/<https:\/\/matrix\.to\/#\/@.+:.+\|(.+)>/g, "$1");

        // Convert plain text body to HTML.
        // We first run it through Slackdown, which will convert some elements to HTML.
        // Then we pass it through the markdown renderer, while letting existing HTML through.
        let formattedBody: string = Slackdown.parse(body);
        formattedBody = this.markdown.render(formattedBody).trim();
        formattedBody = formattedBody.replaceAll("\n", "");

        if (formattedBody === `<p>${body}</p>`) {
            // Formatted body is the same as plain text body, just wrapped in a paragraph.
            // So we consider the message to be plain text.
            formattedBody = "";
        }

        return this.makeTextualEventContent("m.text", body, formattedBody);
    }

    private parseEdit(
        parsedMessage: TextualMessageEventContent,
        parsedPreviousMessage: TextualMessageEventContent,
        previousEvent: EventEntry
    ) {
        const edits  = substitutions.makeDiff(parsedPreviousMessage.body, parsedMessage.body);
        const prev   = substitutions.htmlEscape(edits.prev);
        const curr   = substitutions.htmlEscape(edits.curr);
        const before = substitutions.htmlEscape(edits.before);
        const after  = substitutions.htmlEscape(edits.after);

        const body =
            `(edited) ${edits.before} ${edits.prev} ${edits.after} => ` +
            `${edits.before} ${edits.curr} ${edits.after}`;

        const formattedBody =
            `<i>(edited)</i> ${before} <font color="red"> ${prev} </font> ${after} =&gt; ${before}` +
            `<font color="green"> ${curr} </font> ${after}`;

        const newBody = parsedMessage.body;
        const newFormattedBody = parsedMessage.formatted_body ?? "";

        return {
            ...this.makeTextualEventContent("m.text", body, formattedBody),
            "m.new_content": {
                ...this.makeTextualEventContent("m.text", newBody, newFormattedBody),
            },
            "m.relates_to": {
                rel_type: "m.replace",
                event_id: previousEvent.eventId,
            },
        };
    }

    private async injectExternalUrl(message: ISlackMessageEvent, events: MessageEventContent[]): Promise<MessageEventContent[]> {
        if (!message.team_id) {
            return events;
        }

        const team = await this.datastore.getTeam(message.team_id);
        if (!team || !team.domain) {
            return events;
        }

        let externalUrl = `https://${team.domain}.slack.com/archives/${message.channel}/p${message.ts.replace(".", "")}`;
        if (message.thread_ts) {
            externalUrl = `${externalUrl}?thread_ts=${message.thread_ts.replace(".", "")}`;
        }

        return events.map(event => {
            if (event["m.new_content"]) {
                // It's an edit.
                // Set the external_url on the new content.
                event["m.new_content"].external_url = externalUrl;
            } else {
                event.external_url = externalUrl;
            }
            return event;
        });
    }

    private async getSlackClientForFileHandling(): Promise<WebClient | null> {
        const isPrivateChannel = this.isPrivateChannel && ["channel", "group"].includes(this.slackChannelType);
        if (!isPrivateChannel) {
            return this.botSlackClient;
        }

        // This is a private channel, so bots cannot see images.
        // Attempt to retrieve a user's client.

        const members = Object.keys(await this.bridgeMatrixBot.getJoinedMembers(this.matrixRoomId));
        for (const matrixId of members) {
            const client = await this.slackClientFactory.getClientForUser(this.slackTeamId, matrixId);
            if (client) {
                return client;
            }
        }

        return null;
    }

    private async replaceChannelIdsWithNames(text: string): Promise<string> {
        let match: RegExpExecArray | null = null;
        while ((match = CHANNEL_ID_REGEX.exec(text)) !== null) {
            // foreach channelId, pull out the ID
            // (if this is an emote msg, the format is <#ID|name>, but in normal msgs it's just <#ID>
            const id = match[1];

            // Lookup the room in the store.
            let room = this.roomStore.getBySlackChannelId(id);

            // If we bridge the room, attempt to look up its canonical alias.
            if (room !== undefined) {
                const canonicalEvent = await this.matrixBotIntent.getStateEvent(room.MatrixRoomId, "m.room.canonical_alias", "", true);
                const canonicalAlias = canonicalEvent?.alias;
                if (canonicalAlias) {
                    text = text.slice(0, match.index) + canonicalAlias + text.slice(match.index + match[0].length);
                    log.debug(`Room ${room.MatrixRoomId} does not have a canonical alias`);
                } else {
                    room = undefined;
                }
            }

            // If we can't match the room then we just put the Slack name
            if (room === undefined) {
                const name = await this.getSlackChannelName(id, this.botSlackClient);
                text = text.slice(0, match.index) + `#${name}` + text.slice(match.index + match[0].length);
            }
        }
        return text;
    }

    private async replaceUserIdsWithNames(text: string, teamDomain: string, channelId: string): Promise<string> {
        let match: RegExpExecArray|null = null;
        while ((match = USER_ID_REGEX.exec(text)) !== null) {
            // foreach userId, pull out the ID
            // (if this is an emote msg, the format is <@ID|nick>, but in normal msgs it's just <@ID>
            const id = match[1];

            let displayName = "";
            const userId = await this.ghostStore.getUserId(id, teamDomain);

            const users = await this.datastore.getUser(userId);

            if (!users) {
                log.warn("Mentioned user not in store. Looking up display name from slack.");
                // if the user is not in the store then we look up the displayname
                displayName = await this.ghostStore.getNullGhostDisplayName(channelId, id);
                // If the user is not in the room, we can't pills them, we have to just plain text mention them.
                text = text.slice(0, match.index) + displayName + text.slice(match.index + match[0].length);
            } else {
                displayName = users.display_name || userId;
                text = text.slice(0, match.index) + `<https://matrix.to/#/${userId}|${displayName}>` + text.slice(match.index + match[0].length);
            }
        }
        return text;
    }

    private async getSlackChannelName(channel: string, client: WebClient): Promise<string> {
        try {
            const response = (await client.conversations.info({ channel })) as ConversationsInfoResponse;
            if (response && response.channel && response.channel.name) {
                log.info(`conversations.info: ${channel} mapped to ${response.channel.name}`);
                return response.channel.name;
            }
            log.info("conversations.info returned no result for " + channel);
        } catch (err) {
            log.error("Caught error handling conversations.info:" + err);
        }
        return channel;
    }

    private makeTextualEventContent(
        messageType: "m.text" | "m.emote",
        body: string,
        formattedBody?: string | null,
    ): TextualMessageEventContent {
        const content: TextualMessageEventContent = {
            msgtype: messageType,
            body,
        };

        if (formattedBody && formattedBody !== "") {
            content.format = "org.matrix.custom.html";
            content.formatted_body = formattedBody;
        }

        return content;
    }
}

export const slackFileToMatrixMessage = (file: ISlackFile, url: string, thumbnailUrl?: string): FileMessageEventContent => {
    if (file.mimetype) {
        if (file.mimetype.startsWith("image/")) {
            return slackFileToMatrixImage(file, url, thumbnailUrl);
        } else if (file.mimetype.startsWith("video/")) {
            return slackFileToMatrixVideo(file, url, thumbnailUrl);
        } else if (file.mimetype.startsWith("audio/")) {
            return slackFileToMatrixAudio(file, url);
        }
    }

    return  {
        body: file.title,
        info: {
            mimetype: file.mimetype,
            size: file.size,
        },
        msgtype: "m.file",
        url,
    } as FileMessageEventContent;
};

const slackFileToMatrixImage = (file: ISlackFile, url: string, thumbnailUrl?: string): ImageMessageEventContent => {
    const message = {
        body: file.title,
        info: {
            mimetype: file.mimetype,
            size: file.size,
        },
        msgtype: "m.image",
        url,
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (file.original_w) {
        message.info.w = file.original_w;
    }

    if (file.original_h) {
        message.info.h = file.original_h;
    }

    if (thumbnailUrl) {
        message.thumbnail_url = thumbnailUrl;
        message.thumbnail_info = {};
        if (file.thumb_360_w) {
            message.thumbnail_info.w = file.thumb_360_w;
        }
        if (file.thumb_360_h) {
            message.thumbnail_info.h = file.thumb_360_h;
        }
    }

    return message as ImageMessageEventContent;
};

const slackFileToMatrixAudio = (file: ISlackFile, url: string): AudioMessageEventContent => ({
    body: file.title,
    info: {
        mimetype: file.mimetype,
        size: file.size,
    },
    msgtype: "m.audio",
    url,
} as AudioMessageEventContent);

const slackFileToMatrixVideo = (file: ISlackFile, url: string, thumbnailUrl?: string): VideoMessageEventContent => {
    const message = {
        body: file.title,
        info: {
            mimetype: file.mimetype,
            size: file.size,
        },
        msgtype: "m.video",
        url,
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (file.original_w) {
        message.info.w = file.original_w;
    }

    if (file.original_h) {
        message.info.h = file.original_h;
    }

    if (thumbnailUrl) {
        message.thumbnail_url = thumbnailUrl;
        // Slack doesn't tell us the thumbnail size for videos.
    }

    return message as VideoMessageEventContent;
};

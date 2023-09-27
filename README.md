# matrix-appservice-slack

This is **a fork of [matrix-appservice-slack](https://github.com/matrix-org/matrix-appservice-slack)**, which adds some new features and fixes several issues that have been longstanding upstream. This fork is a **drop-in replacement** for the upstream bridge, see [Usage](#usage) for deployment instructions. 

The Slack bridge of the [community.wordpress.org](https://community.wordpress.org) homeserver is running this fork.

## Features

In addition to all features of the upstream bridge, this fork adds the following:

- Matrix puppeting
  - Disabled by default, see [Matrix puppeting](#matrix-puppeting).
- Support for the following [Slack attachment](https://api.slack.com/reference/messaging/attachments) fields [[#18](https://github.com/Automattic/matrix-appservice-slack/pull/18)]:
  - `pretext`
  - `title`
  - `title_link`
  - `author_name`
  - `blocks`
- Support for the following [Slack block](https://api.slack.com/reference/block-kit/blocks) types [[#19](https://github.com/Automattic/matrix-appservice-slack/pull/19)]:
  - `header`
  - `section`
  - `content`
  - `divider`
- Admin command for exporting the list of bridged rooms/channels as a CSV [[#4](https://github.com/Automattic/matrix-appservice-slack/pull/4)]
- Set `external_url` property on messages sent to Matrix [[#3](https://github.com/Automattic/matrix-appservice-slack/pull/3)]
- Set `eventId` and `roomId` as metadata of events sent to Slack [[#8](https://github.com/Automattic/matrix-appservice-slack/pull/8)]

## Fixes

- Fix issue that caused message edits on Slack to not be reflected on Matrix [[#7](https://github.com/Automattic/matrix-appservice-slack/pull/7)] [[upstream fix #761](https://github.com/matrix-org/matrix-appservice-slack/pull/761)]
- Fix issue that caused files sent to a thread on Slack to be posted on the main timeline on Matrix [[#20](https://github.com/Automattic/matrix-appservice-slack/pull/20)] [[upstream issue #671](https://github.com/matrix-org/matrix-appservice-slack/issues/671)]
- Fix issue that caused channel name to not be displayed in the output of the `link` and `list` admin commands [[upstream fix #756](https://github.com/matrix-org/matrix-appservice-slack/pull/756)]

## Usage

This fork is a drop-in replacement for the upstream bridge, so the setup instructions are the same as upstream. The only difference is of course that you need to get the code from this fork:

**From source:**

```shell
git clone https://github.com/Automattic/matrix-appservice-slack.git
cd matrix-appservice-slack
yarn install
yarn build
```

**With Docker:**

```shell
docker pull ghcr.io/automattic/matrix-appservice-slack:latest
```

Then follow the upstream [setup instructions](https://matrix-appservice-slack.readthedocs.io/en/latest/getting_started/).


## Matrix puppeting

> While this feature is currently in use in production at `community.wordpress.org`, it should be considered **experimental**. Use at your own risk. If you do end up using it and encounter any problems, please consider [opening an issue](https://github.com/matrix-org/matrix-appservice-slack/issues/new).
> 
> To use this feature, you must have a means of knowing the Matrix usernames of Slack users. If it's not possible for you to obtain this information, **you will not be able to use this feature.**

This fork adds a new feature (disabled by default) that allows the bridge to post as an actual Matrix user (`@foo:example.org`), instead of a Slack "ghost" (`@slack_team_UABC123:example.org`).

The bridge has two methods for retrieving the Matrix username of a given Slack user:

1. By querying the `matrix_usernames` table in the bridge's database.
2. By querying a remote endpoint, which must you must make available at a URL that is accessible to the bridge. This allows you to fetch the information from a database or another system you control. If successful, the Matrix username is stored in the `matrix_usernames` table, and the endpoint will no longer be queried for the given Slack user.

If the bridge can't find the Matrix username, it will fall back to the default behaviour of posting as a "ghost" user.

### Where do I find the Slack-Matrix user mapping?

You need to produce this mapping yourself, possibly by [downloading the list of Slack users](https://slack.com/help/articles/4405848563603-Download-a-list-of-members-in-your-workspace), and then manually finding the username of the respective Matrix user. Note that if new Slack users join the Slack Workspace, you'll need to add them to the mapping, so you probably want to automate this in some way.

### Configuration
To enable the Matrix puppeting feature, modify the bridge's configuration as follows:

```yml
# config.yaml

# ...

matrix_username_store:
  enabled: true
  team_domain: "foo" # foo.slack.com
```

Additionally, the bridge's appservice configuration requires some changes compared to upstream. This is because the bridge must be able to act as all users, not just `@slack_*` users. You'll want to change the `namespaces.users` configuration as follows:

```yml
# slack-registration.yml

# ...

namespaces:
  users:
    - exclusive: false
      regex: '@.*:'
```

> This won't do anything yet, please keep reading for further instructions.

### Adding the information to the `matrix_usernames` table

> If you plan to implement a [remote endpoint](#retrieve-matrix-username-from-a-remote-endpoint) that returns the information, the `matrix_usernames` table acts as a local cache, so this step is optional in that case.

We'll assume you have the Slack-Matrix user mapping in the form of a CSV file with the following structure:

```CSV
slack_id, matrix_username
UABC123, foo
UXYZ789, bar
```

You can import this file with a database query:

```sql
COPY matrix_usernames(slack_id, matrix_username) FROM '/path/to/mapping.csv' WITH (FORMAT csv);
```

Alternatively, you can use SQL directly:

```sql
insert into matrix_usernames (slack_id, matrix_username)
values  ('UABC123', 'foo'),
        ('UXYZ789', 'bar')
on conflict (slack_id) do nothing
```

### Retrieving Matrix username from a remote endpoint
As mentioned above, the bridge can retrieve the Matrix username of a given Slack user from a remote URL, if it doesn't find it locally in the `matrix_usernames` table.

This feature must be enabled through the bridge's configuration:

```yml
# config.yml

# ...

matrix_username_store:
  enabled: true
  team_domain: "foo" # foo.slack.com
  url: "https://example.org/slack-matrix-mapping"
  secret: "bar" # Change this to a random alphanumeric long string
```

The bridge will then make `GET` requests to the following URL when it doesn't find the information locally: 

```
https://example.org/slack-matrix-mapping?secret=bar&slack_id=UABC123
```

The endpoint should respond with `401` when the secret doesn't match, `404` when the Matrix username was not found, or `200` and the following response:

```json
{
  "slack": "UABC123",
  "matrix": "janedoe"
}
```

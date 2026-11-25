// Chat titles: a short AI title for a chat from its first message (the CLI
// chat's tab). The chat itself is the CLI chat (services/clichat); what runs
// the agent is the CLI, not this module.

mod title;

/// A short AI title for a chat from its first message.
pub async fn title(message: String) -> String {
    title::title(&message).await
}

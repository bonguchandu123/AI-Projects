/**
 * SYNTHETIC DEMONSTRATION DATA — not real conversations.
 * StudyMate is a fictional project used to demonstrate decision lifecycle tracking.
 * Every row created from this dataset is flagged is_demo = true and shown as "Demo data" in the UI.
 */
export const DEMO_PROJECT = {
  name: "StudyMate",
  description:
    "Demo project (synthetic data): a study-planning app for students. Used to demonstrate how ContextOS tracks decisions from proposal to verified implementation.",
};

export interface DemoConversation {
  title: string;
  occurredAt: string; // ISO date
  text: string;
}

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    title: "Project kickoff",
    occurredAt: "2026-01-12T10:00:00Z",
    text: [
      "Asha: We are building StudyMate. Initially, we are planning to use MongoDB because it is easy to integrate with our Node.js backend.",
      "Ravi: We decided to deploy the backend on Heroku because the free tier is enough for the beta.",
      "Arjun: I will build the public API documentation portal by the end of February.",
    ].join("\n"),
  },
  {
    title: "Data model review",
    occurredAt: "2026-02-09T15:30:00Z",
    text: [
      "Asha: We are considering PostgreSQL because we need relational data and stronger consistency.",
      "Ravi: Someone suggested adding Redis as a cache for session data.",
      "Asha: We rejected Redis because our traffic is low and it adds operational overhead.",
    ].join("\n"),
  },
  {
    title: "Database decision meeting",
    occurredAt: "2026-03-03T11:00:00Z",
    text: [
      "Asha: After comparing both databases, we have decided to migrate StudyMate from MongoDB to PostgreSQL because of relational data requirements.",
      "Priya: Priya will write the data migration runbook by March 20.",
      "Ravi: We decided to use Stripe for subscription payments because it supports student discounts.",
    ].join("\n"),
  },
  {
    title: "Infrastructure sync",
    occurredAt: "2026-03-18T09:00:00Z",
    text: [
      "Ravi: We are moving hosting from Heroku to Render because Render's pricing is predictable for our usage.",
      "Arjun: We cancelled the API documentation portal task because the public beta was postponed.",
    ].join("\n"),
  },
  {
    title: "Sprint 8 status",
    occurredAt: "2026-04-14T16:00:00Z",
    text: [
      "Priya: The PostgreSQL migration has been implemented.",
      "Ravi: The Stripe payment integration has been implemented.",
    ].join("\n"),
  },
  {
    title: "Production readiness review",
    occurredAt: "2026-05-20T14:00:00Z",
    text: [
      "Asha: We tested the application and confirmed that PostgreSQL is running successfully in production.",
      "Priya: Priya finished the data migration runbook.",
      "Ravi: Ravi will add payment failure alerts by June 15.",
    ].join("\n"),
  },
  {
    title: "Support hand-off notes",
    occurredAt: "2026-06-02T10:30:00Z",
    text: ["Kiran: StudyMate still stores user data in MongoDB."].join("\n"),
  },
];

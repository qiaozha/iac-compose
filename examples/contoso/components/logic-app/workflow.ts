import { fn, type ExpressionOrValue } from "@azure/provisioning-core";

export interface AutoReplyWorkflowInputs {
  teamsChannelIds: ExpressionOrValue<string[]>;
  teamsGroupId: ExpressionOrValue<string>;
  backendAudience: ExpressionOrValue<string>;
  backendIdentityResourceId: ExpressionOrValue<string>;
  backendBaseUrl: ExpressionOrValue<string>;
  frontendAudience: ExpressionOrValue<string>;
  botIdentityResourceId: ExpressionOrValue<string>;
  frontendBaseUrl: ExpressionOrValue<string>;
}

export function createAutoReplyWorkflowDefinition(inputs: AutoReplyWorkflowInputs) {
  return {
    "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
      "$connections": {
        "defaultValue": {},
        "type": "Object",
      },
    },
    "triggers": {
      "When_a_new_message_is_added_to_a_channel": {
        "type": "ApiConnectionWebhook",
        "inputs": {
          "body": {
            "channels": inputs.teamsChannelIds,
            "groupId": inputs.teamsGroupId,
            "notificationUrl": "@listCallbackUrl()",
          },
          "host": {
            "connection": {
              "name": "@parameters('$connections')['teams']['connectionId']",
            },
          },
          "path": "/beta/subscriptions/newmessagetrigger/threadType/@{encodeURIComponent('channel')}",
        },
      },
    },
    "actions": {
      "For_each_message": {
        "type": "Foreach",
        "foreach": "@triggerBody()?['value']",
        "runAfter": {},
        "actions": {
          "Get_message_details": {
            "type": "ApiConnection",
            "inputs": {
              "body": {
                "recipient": {
                  "channelId": "@item()?['channelId']",
                  "groupId": inputs.teamsGroupId,
                  "parentMessageId": "@item()?['replyToMessageId']",
                },
              },
              "host": {
                "connection": {
                  "name": "@parameters('$connections')['teams']['connectionId']",
                },
              },
              "method": "post",
              "path": "/beta/teams/messages/@{encodeURIComponent(item()?['messageId'])}/messageType/@{encodeURIComponent('channel')}",
            },
          },
          "Filter_bot_mentions": {
            "type": "Query",
            "inputs": {
              "from": "@coalesce(body('Get_message_details')?['mentions'], json('[]'))",
              "where": "@not(equals(item()?['mentioned']?['application'], null))",
            },
            "runAfter": {
              "Get_message_details": [
                "Succeeded",
              ],
            },
          },
          "Filter_announcements": {
            "type": "Query",
            "inputs": {
              "from": "@coalesce(body('Get_message_details')?['attachments'], json('[]'))",
              "where": "@equals(item()?['contentType'], 'application/vnd.microsoft.teams.messaging-announcementBanner')",
            },
            "runAfter": {
              "Filter_bot_mentions": [
                "Succeeded",
              ],
            },
          },
          "Filter_meetings": {
            "type": "Query",
            "inputs": {
              "from": "@coalesce(body('Get_message_details')?['attachments'], json('[]'))",
              "where": "@equals(item()?['contentType'], 'meetingReference')",
            },
            "runAfter": {
              "Filter_announcements": [
                "Succeeded",
              ],
            },
          },
          "Process_user_message": {
            "type": "If",
            "expression": {
              "and": [
                {
                  "equals": [
                    "@body('Get_message_details')?['messageType']",
                    "message",
                  ],
                },
                {
                  "equals": [
                    "@length(body('Filter_announcements'))",
                    0,
                  ],
                },
                {
                  "equals": [
                    "@length(body('Filter_meetings'))",
                    0,
                  ],
                },
                {
                  "equals": [
                    "@body('Get_message_details')?['from']?['application']",
                    "@null",
                  ],
                },
              ],
            },
            "runAfter": {
              "Filter_meetings": [
                "Succeeded",
              ],
            },
            "actions": {
              "Build_conversation_message": {
                "type": "Compose",
                "inputs": {
                  "id": "@item()?['messageId']",
                  "sender_role": "user",
                  "sender_id": "@body('Get_message_details')?['from']?['user']?['id']",
                  "sender_name": "@body('Get_message_details')?['from']?['user']?['displayName']",
                  "content": "@body('Get_message_details')?['body']?['content']",
                  "created_at": "@body('Get_message_details')?['createdDateTime']",
                  "conversation_id": "@concat(body('Get_message_details')?['channelId'], ';messageid=', if(empty(body('Get_message_details')?['replyToId']), body('Get_message_details')?['id'], body('Get_message_details')?['replyToId']))",
                  "conversation_type": "teams_channel",
                  "extra_info": {
                    "channel_id": "@item()?['channelId']",
                    "message_link": "@body('Get_message_details')?['messageLink']",
                  },
                },
              },
              "Save_conversation_message": {
                "type": "Http",
                "inputs": {
                  "authentication": {
                    "audience": inputs.backendAudience,
                    "identity": inputs.backendIdentityResourceId,
                    "type": "ManagedServiceIdentity",
                  },
                  "body": "@outputs('Build_conversation_message')",
                  "method": "POST",
                  "uri": fn.concat(inputs.backendBaseUrl, "/conversation/save"),
                },
                "runAfter": {
                  "Build_conversation_message": [
                    "Succeeded",
                  ],
                },
              },
              "Message_does_not_mention_bot": {
                "type": "If",
                "expression": {
                  "equals": [
                    "@length(body('Filter_bot_mentions'))",
                    0,
                  ],
                },
                "runAfter": {
                  "Save_conversation_message": [
                    "Succeeded",
                  ],
                },
                "actions": {
                  "Build_intention_request": {
                    "type": "Compose",
                    "inputs": {
                      "conversation_id": "@outputs('Build_conversation_message')?['conversation_id']",
                      "conversation_type": "teams_channel",
                      "message": {
                        "id": "@item()?['messageId']",
                        "role": "user",
                        "content": "@body('Get_message_details')?['body']?['content']",
                        "user_id": "@body('Get_message_details')?['from']?['user']?['id']",
                        "user_name": "@body('Get_message_details')?['from']?['user']?['displayName']",
                      },
                    },
                  },
                  "Check_intention": {
                    "type": "Http",
                    "inputs": {
                      "authentication": {
                        "audience": inputs.backendAudience,
                        "identity": inputs.backendIdentityResourceId,
                        "type": "ManagedServiceIdentity",
                      },
                      "body": "@outputs('Build_intention_request')",
                      "method": "POST",
                      "uri": fn.concat(inputs.backendBaseUrl, "/message/intention"),
                    },
                    "runAfter": {
                      "Build_intention_request": [
                        "Succeeded",
                      ],
                    },
                  },
                  "Should_reply": {
                    "type": "If",
                    "expression": {
                      "equals": [
                        "@body('Check_intention')?['should_respond']",
                        true,
                      ],
                    },
                    "runAfter": {
                      "Check_intention": [
                        "Succeeded",
                      ],
                    },
                    "actions": {
                      "Convert_Teams_activity": {
                        "type": "Http",
                        "inputs": {
                          "authentication": {
                            "audience": inputs.backendAudience,
                            "identity": inputs.backendIdentityResourceId,
                            "type": "ManagedServiceIdentity",
                          },
                          "body": "@body('Get_message_details')",
                          "method": "POST",
                          "uri": fn.concat(inputs.backendBaseUrl, "/teams/activity/convert"),
                        },
                      },
                      "Invoke_frontend_bot": {
                        "type": "Http",
                        "inputs": {
                          "authentication": {
                            "audience": inputs.frontendAudience,
                            "identity": inputs.botIdentityResourceId,
                            "type": "ManagedServiceIdentity",
                          },
                          "body": "@body('Convert_Teams_activity')",
                          "headers": {
                            "Content-Type": "application/json",
                          },
                          "method": "POST",
                          "retryPolicy": {
                            "type": "none",
                          },
                          "uri": fn.concat(inputs.frontendBaseUrl, "/api/messages"),
                        },
                        "runAfter": {
                          "Convert_Teams_activity": [
                            "Succeeded",
                          ],
                        },
                      },
                    },
                    "else": {
                      "actions": {},
                    },
                  },
                },
                "else": {
                  "actions": {},
                },
              },
            },
            "else": {
              "actions": {},
            },
          },
        },
      },
    },
    "outputs": {},
  };
}

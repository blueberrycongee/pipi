import { List, mount, signal, Text, View } from "nsh";
import { markRowsSeen } from "../ui/motion";
import { pipBubbleRows } from "../views/Prose";
import { TranscriptRow, type ChatRow } from "../views/Rows";

const rows = signal<ChatRow[]>([]);
const user: ChatRow = {
  kind: "user", id: "sent", text: "A message for Pip", images: 0,
  sms: { first: true, last: true, receipt: "read" },
};
const replies = pipBubbleRows({ id: "reply", text: "Here is the first thought.\n\nAnd a second thought." });
markRowsSeen([]);

mount(() => (
  <View class="flex-1 bg-background p-8">
    <View testID="deliver" onPress={() => setTimeout(() => rows.set([user, ...replies]), 800)}>
      <Text>Deliver</Text>
    </View>
    <View testID="single" onPress={() => setTimeout(() => rows.set([
      user, ...pipBubbleRows({ id: "single", text: "One complete reply." }),
    ]), 800)}>
      <Text>Single reply</Text>
    </View>
    <View testID="remount" onPress={() => {
      rows.set([]);
      setTimeout(() => rows.set([user, ...replies]), 800);
    }}>
      <Text>Remount</Text>
    </View>
    <View testID="history" onPress={() => {
      rows.set([]);
      markRowsSeen(["sent", "reply"]);
      setTimeout(() => rows.set([user, ...replies]), 800);
    }}>
      <Text>History</Text>
    </View>
    <List each={rows()} keyExtractor={(row) => row.id} estimatedItemSize={60} class="flex-1">
      {(row) => <TranscriptRow row={row()} activityMaxHeight={320} />}
    </List>
  </View>
));

import { AssistantChat } from '../../components/PetChatDialog'

// The pet assistant's conversation as a dock panel: it pops out to a window like any
// other panel, and it shows which assistant it is (the header names the pet).
export default function AssistantPanel({ bornAt }: { bornAt: number }): JSX.Element {
  return <AssistantChat bornAt={bornAt} />
}

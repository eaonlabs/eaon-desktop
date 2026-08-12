// Assistant reply body: prose, with any write_file/edit_file fence lifted
// out and rendered as a reviewable diff card instead of a block of JSON.
//
// The overwhelming majority of replies contain no such fence, so the cheap
// `hasFileDiff` guard short-circuits straight to plain Markdown and this
// costs them nothing.

import { memo, useMemo } from "react";
import { hasFileDiff, segmentAssistantContent } from "../../core/protocol/fileDiff";
import { extractSwarmPanel } from "../../core/protocol/swarm";
import FileDiffCard from "./FileDiffCard";
import SwarmCard from "./SwarmCard";
import Markdown from "./Markdown";

interface AssistantContentProps {
  content: string;
}

const AssistantContent = memo(function AssistantContent({ content }: AssistantContentProps) {
  // The swarm panel is a base64 block at the very front of the message, put
  // there before streaming began — peel it off first so the rest is treated
  // as the actual reply.
  const { transcript, remainder } = useMemo(() => extractSwarmPanel(content), [content]);
  const segments = useMemo(
    () => (hasFileDiff(remainder) ? segmentAssistantContent(remainder) : null),
    [remainder],
  );

  return (
    <>
      {transcript && <SwarmCard transcript={transcript} />}
      {segments
        ? segments.map((segment, index) =>
            segment.kind === "markdown" ? (
              <Markdown key={index} content={segment.text} />
            ) : (
              <FileDiffCard key={index} diff={segment.diff} isStreaming={segment.isStreaming} />
            ),
          )
        : remainder && <Markdown content={remainder} />}
    </>
  );
});

export default AssistantContent;

// Why the computer turned a request down, in words.
export function reason(error: string): string {
  switch (error) {
    case 'not-open':
      return '컴퓨터에서 이 패널이 닫혀 있어요.'
    case 'timeout':
      return '컴퓨터가 응답하지 않아요.'
    case 'no-workspace':
      return '그 워크스페이스가 컴퓨터에서 열려 있지 않아요.'
    case 'no-chat':
      return '그 챗이 컴퓨터에 없어요.'
    case 'no-job':
      return '이미 지워진 예약 작업이에요.'
    case 'bad-model':
    case 'bad-mode':
      return '컴퓨터에서 고를 수 없는 값이에요.'
    default:
      return error
  }
}

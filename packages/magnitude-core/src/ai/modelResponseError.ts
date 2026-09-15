export class ModelResponseError extends Error {
    constructor(public readonly reason: 'refusal' | 'max_tokens') {
        super(reason === 'refusal' ? 'Model refused the request' : 'Model response exceeded its output-token limit');
        this.name = 'ModelResponseError';
    }
}

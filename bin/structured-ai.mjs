import Ajv from 'ajv';

export async function invokeLLM(params, askAi) {
  if (!params || typeof params.prompt !== 'string' || params.prompt.length > 100000 || Object.keys(params).some(key => !['prompt', 'response_json_schema'].includes(key))) throw new Error('Parâmetros de IA não suportados. Use prompt e response_json_schema.');
  let validate;
  if (params.response_json_schema !== undefined) {
    try { validate = new Ajv({ strict: true, allErrors: true }).compile(params.response_json_schema); }
    catch { throw new Error('O JSON Schema solicitado não é suportado ou está inválido.'); }
  }
  const prompt = params.prompt + (validate ? '\nRetorne somente JSON válido que cumpra este schema, sem alterar campos:\n' + JSON.stringify(params.response_json_schema) : '');
  const raw = await askAi([{ role: 'user', content: prompt }]);
  if (!validate) return raw;
  let result;
  try { result = JSON.parse(String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()); }
  catch { throw new Error('A IA retornou JSON inválido. Tente novamente.'); }
  if (!validate(result)) throw new Error('A resposta da IA não corresponde ao schema solicitado: ' + validate.errors.map(error => (error.instancePath || '/') + ' ' + error.keyword).join(', '));
  return result;
}

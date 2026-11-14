import { memo } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { averageFor, durationFor, LATENCY_METRICS, LatencyRecord } from '../services/latency';

const format = (value: number | undefined) => value === undefined ? '—' : `${Math.round(value).toLocaleString('de-CH')} ms`;
const statusLabels: Record<LatencyRecord['status'], string> = {
  pending: 'Läuft', measured: 'Gemessen', cancelled: 'Abgebrochen', error: 'Fehler', 'text-only': 'Audio aus', silent: 'Kein hörbarer Ton'
};
const ttsNames: Record<string, string> = { suisse: 'Suisse Speech', gradio: 'FHNW', slang: 'Slang' };
const sttNames: Record<string, string> = { suisse: 'Suisse Speech', azure: 'Azure Speech' };

export const LatencyPanel = memo(({ records, onReset }: { records: LatencyRecord[]; onReset: () => void }) => {
  const main = averageFor(records, LATENCY_METRICS[0]);
  const latest = records[records.length - 1];
  return (
    <Accordion disableGutters elevation={0} sx={{ flexShrink: 0, borderBottom: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMore />} aria-controls="latency-details" id="latency-heading">
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography fontWeight={600}>Latenzmessung</Typography>
          <Chip size="small" label={`Ø Sprechpause ${format(main.value)} · n=${main.count}`} />
          <Typography variant="caption" color="text.secondary">{records.length} Antworten</Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails id="latency-details" sx={{ maxHeight: '45vh', overflow: 'auto', pt: 0 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Hauptwert: letztes Sprachsample bis zum ersten Antwortton (geschätzt). Das Sprachende stammt bei Azure aus der Audiozeitleiste der Erkennung, bei Suisse Speech aus der lokalen Pausenerkennung im Mikrofonsignal. Die Ausgabe stammt aus der Browser-Wiedergabezeit. Hardware und Systemlautstärke sind nicht direkt messbar.
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          Texteingaben erhalten keinen Sprechpausenwert. Durchschnitte gelten seit dem Zurücksetzen über alle Provider; fehlende, fehlerhafte und vor der Wiedergabe abgebrochene Messungen zählen nicht. Bei FHNW/Slang bedeutet „erstes Audio“ die geladene Audiodatei. Parallele Schritte nicht addieren.
        </Typography>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">Ø Sprachende → Antwortton</Typography>
            <Typography variant="h5" color="primary.main" fontWeight={600}>{format(main.value)}</Typography>
          </Box>
          <Button size="small" onClick={onReset} disabled={!records.length}>Zurücksetzen</Button>
        </Stack>
        {records.length ? (
          <>
            <TableContainer>
              <Table size="small" aria-label="Durchschnittliche Antwortlatenzen">
                <TableHead><TableRow><TableCell>Schritt</TableCell><TableCell align="right">Letzte Antwort</TableCell><TableCell align="right">Durchschnitt</TableCell></TableRow></TableHead>
                <TableBody>
                  {LATENCY_METRICS.map(metric => {
                    const average = averageFor(records, metric);
                    return <TableRow key={metric.id}>
                      <TableCell>{metric.label}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{latest ? format(durationFor(latest, metric)) : '—'}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{format(average.value)} <Typography component="span" variant="caption" color="text.secondary">(n={average.count})</Typography></TableCell>
                    </TableRow>;
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>Einzelne Antworten · neueste zuerst</Typography>
            {[...records].reverse().map(record => (
              <Accordion key={record.id} disableGutters elevation={0} sx={{ border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<ExpandMore />} aria-controls={`latency-answer-${record.id}`}>
                  <Box sx={{ minWidth: 0, width: '100%' }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="body2" fontWeight={600}>#{record.id} · {record.source === 'voice' ? 'Mikrofon' : 'Text'}</Typography>
                      <Chip size="small" label={statusLabels[record.status]} />
                      <Typography variant="body2" fontWeight={600}>
                        {format(durationFor(record, LATENCY_METRICS[record.source === 'voice' ? 0 : 1]))}
                      </Typography>
                    </Stack>
                    <Typography variant="body2" noWrap title={record.text}>{record.text}</Typography>
                    <Typography variant="caption" color="text.secondary">{record.model}{record.reasoningLevel ? ` · Denken: ${record.reasoningLevel}` : ''}{record.stt ? ` · STT: ${sttNames[record.stt]}` : ''} · {ttsNames[record.tts] ?? record.tts} · {record.dialect}</Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails id={`latency-answer-${record.id}`}>
                  {record.source === 'voice' && record.steps.speechEnd === undefined ? (
                    <Typography variant="caption" color="text.secondary">Kein verlässlicher Audiozeitpunkt für das Sprachende verfügbar; der Hauptwert bleibt leer.</Typography>
                  ) : null}
                  {record.outputTiming ? <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                    Ausgabezeit: {record.outputTiming === 'output-clock' ? 'Audio-Ausgabeuhr mit Erkennung führender Stille' : record.outputTiming === 'media-event' ? 'Wiedergabe-Ereignis des Browsers; führende Dateistille nicht erfasst' : 'Audioplanung mit geschätzter Geräteverzögerung und Erkennung führender Stille'}.
                  </Typography> : null}
                  <Table size="small" aria-label={`Latenzschritte Antwort ${record.id}`}><TableBody>
                    {LATENCY_METRICS.map(metric => <TableRow key={metric.id}><TableCell>{metric.label}</TableCell><TableCell align="right">{format(durationFor(record, metric))}</TableCell></TableRow>)}
                  </TableBody></Table>
                </AccordionDetails>
              </Accordion>
            ))}
          </>
        ) : <Typography variant="body2" color="text.secondary">Die nächste Antwort startet die erste Messung. Audio einschalten, um die Antwortlatenz zu erfassen.</Typography>}
      </AccordionDetails>
    </Accordion>
  );
});

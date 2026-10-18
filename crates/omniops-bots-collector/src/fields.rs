use std::fmt;

use tracing::{
    Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_subscriber::{
    Layer,
    field::{RecordFields, VisitOutput},
    fmt::{
        FormatFields, FormattedFields,
        format::{DefaultFields, DefaultVisitor, Writer},
    },
    layer::Context,
    registry::LookupSpan,
};

/// Pair this layer with the fmt layer using the same field formatter and filter.
pub(crate) struct CurrentFields;

impl<S> Layer<S> for CurrentFields
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        update(id, ctx, attrs);
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        update(id, ctx, values);
    }
}

fn update<S>(id: &Id, ctx: Context<'_, S>, values: impl RecordFields)
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let Some(span) = ctx.span(id) else {
        return;
    };
    let mut extensions = span.extensions_mut();
    if extensions.get_mut::<SpanFields>().is_none() {
        // One slot per declared field: repeated records cannot grow the cache.
        extensions.insert(SpanFields(vec![
            String::new();
            span.metadata().fields().len()
        ]));
    }
    let fields = extensions.get_mut::<SpanFields>().expect("fields inserted");
    values.record(fields);
    let text = fields
        .0
        .iter()
        .filter(|s| !s.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    extensions.replace(FormattedFields::<CurrentFields>::new(text));
}

impl<'writer> FormatFields<'writer> for CurrentFields {
    fn format_fields<R: RecordFields>(&self, writer: Writer<'writer>, fields: R) -> fmt::Result {
        DefaultFields::new().format_fields(writer, fields)
    }

    fn add_fields(&self, _: &mut FormattedFields<Self>, _: &Record<'_>) -> fmt::Result {
        // The paired layer atomically replaces the cache; fmt must not append to it.
        Ok(())
    }
}

struct SpanFields(Vec<String>);

impl SpanFields {
    fn record(&mut self, field: &Field, record: impl FnOnce(&mut DefaultVisitor<'_>)) {
        let mut text = String::new();
        let mut visitor = DefaultVisitor::new(Writer::new(&mut text), true);
        record(&mut visitor);
        if visitor.finish().is_ok() {
            self.0[field.index()] = text;
        }
    }
}

impl Visit for SpanFields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.record(field, |visitor| visitor.record_debug(field, value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, |visitor| visitor.record_str(field, value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.record(field, |visitor| visitor.record_error(field, value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        sync::{Arc, Mutex},
    };
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn updates_replace_values_without_losing_context_or_changing_event_format() {
        #[derive(Clone, Default)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl io::Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::registry().with(
            CurrentFields.and_then(
                tracing_subscriber::fmt::layer()
                    .fmt_fields(CurrentFields)
                    .without_time()
                    .with_level(false)
                    .with_target(false)
                    .with_ansi(false)
                    .with_writer(move || writer.clone()),
            ),
        );
        tracing::subscriber::with_default(subscriber, || {
            let run = tracing::info_span!("run", node_id = %"node", phase = "ready", tries = 0_u64,
                late = tracing::field::Empty, unset = tracing::field::Empty);
            let _run = run.enter();
            tracing::info!("started");
            for attempt in 1..=100 {
                run.record("phase", "running").record("tries", attempt);
            }
            let step = tracing::info_span!("step", phase = "lookup");
            step.in_scope(|| {
                step.record("phase", "body").record("phase", "route");
                run.record("phase", "completed")
                    .record("late", "value with phase=\"old\" { }\n");
                tracing::info!(event = "done", ok = true, "finished");
            });
        });
        let output = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            output,
            concat!(
                "run{node_id=node phase=\"ready\" tries=0}: started\n",
                "run{node_id=node phase=\"completed\" tries=100 late=\"value with phase=\\\"old\\\" { }\\n\"}:step{phase=\"route\"}: finished event=\"done\" ok=true\n",
            )
        );
    }
}

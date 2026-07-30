export default function Footer() {
  return (
    <footer className="mt-16 border-t bg-white">

      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-center md:flex-row">

        <div>

          <h2 className="text-lg font-bold text-blue-700">
            MeetSched
          </h2>

          <p className="text-sm text-gray-500">
            Smart Meeting Scheduling Platform
          </p>

        </div>

        <div className="text-sm text-gray-500">
          © {new Date().getFullYear()} MeetSched. All Rights Reserved.
        </div>

      </div>

    </footer>
  );
}